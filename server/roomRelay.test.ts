import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { rooms } from "../drizzle/schema";
import { getDb } from "./db";
import { createRoom, leaveRoom } from "./rooms";
import { allowedSocketOrigin, closeBurnedRoomSockets, handshakeClientIdentity, registerRoomRelay, type MessageAck } from "./roomRelay";

type RelayHarness = { server: HttpServer; socket: Socket; roomId: string; guestToken: string };

function envelope(messageId: string, sequence: number) {
  return { messageId, sequence, ciphertext: "c".repeat(24), iv: "i".repeat(16), sentAt: Date.now() };
}

async function startRelay(): Promise<RelayHarness> {
  const room = await createRoom(`relay-${Date.now()}-${randomBytes(3).toString("hex")}`, randomBytes(32).toString("base64url"));
  const server = createServer();
  const relay = registerRoomRelay(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  const socket = io(`http://127.0.0.1:${address.port}`, { path: "/api/realtime", transports: ["websocket"], auth: { roomId: room.roomId, guestToken: room.guestToken } });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  server.once("close", () => relay.close());
  return { server, socket, roomId: room.roomId, guestToken: room.guestToken };
}

function send(socket: Socket, payload: ReturnType<typeof envelope>) {
  return new Promise<MessageAck>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Acknowledgement timed out")), 5_000);
    socket.emit("room:message", payload, (acknowledgement: MessageAck) => {
      clearTimeout(timeout);
      resolve(acknowledgement);
    });
  });
}

describe("room relay message acknowledgements", () => {
  const harnesses: RelayHarness[] = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(async ({ server, socket, roomId, guestToken }) => {
      socket.disconnect();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await leaveRoom(roomId, guestToken).catch(() => undefined);
    }));
  });

  it("accepts only exact configured origins for production Socket.IO handshakes", () => {
    const origins = "https://cryptroom.example.com,https://app.example.com";
    expect(allowedSocketOrigin("https://cryptroom.example.com", "production", origins)).toBe(true);
    expect(allowedSocketOrigin("https://cryptroom.example.com.evil.test", "production", origins)).toBe(false);
    expect(allowedSocketOrigin("https://evil.example.com", "production", origins)).toBe(false);
    expect(allowedSocketOrigin(undefined, "production", origins)).toBe(false);
  });

  it("uses a forwarded client IP only for the explicit trusted-proxy deployment model", () => {
    const handshake = { address: "10.0.0.8", headers: { "x-forwarded-for": "203.0.113.44, 10.0.0.1" } } as Parameters<typeof handshakeClientIdentity>[0];
    expect(handshakeClientIdentity(handshake, false)).toBe("10.0.0.8");
    expect(handshakeClientIdentity(handshake, true)).toBe("203.0.113.44");
    expect(handshakeClientIdentity({ address: "10.0.0.8", headers: { "x-forwarded-for": "not-an-ip" } } as Parameters<typeof handshakeClientIdentity>[0], true)).toBe("10.0.0.8");
  });

  it("acknowledges accepted messages and explicitly rejects malformed and replayed envelopes", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    const accepted = await send(harness.socket, envelope("a".repeat(22), 1));
    expect(accepted).toEqual({ ok: true });
    await expect(send(harness.socket, { ...envelope("b".repeat(22), 2), iv: "bad" })).resolves.toMatchObject({ ok: false, code: "INVALID_ENVELOPE" });
    await expect(send(harness.socket, envelope("a".repeat(22), 1))).resolves.toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
  }, 60_000);

  it("does not crash when a raw client omits the acknowledgement callback", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    harness.socket.emit("room:message", envelope("n".repeat(22), 1));
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(harness.socket.connected).toBe(true);
    await expect(send(harness.socket, envelope("o".repeat(22), 2))).resolves.toEqual({ ok: true });
  }, 60_000);

  it("accepts distinct monotonic messages from two sockets owned by one authenticated participant", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    const address = harness.server.address();
    if (!address || typeof address === "string") throw new Error("Test server missing address");
    const sibling = io(`http://127.0.0.1:${address.port}`, { path: "/api/realtime", transports: ["websocket"], auth: { roomId: harness.roomId, guestToken: harness.guestToken } });
    await new Promise<void>((resolve, reject) => { sibling.once("connect", () => resolve()); sibling.once("connect_error", reject); });
    try {
      for (let sequence = 1; sequence <= 4; sequence += 1) {
        const sender = sequence % 2 ? harness.socket : sibling;
        await expect(send(sender, envelope(sequence.toString(36).padStart(22, "m"), sequence))).resolves.toEqual({ ok: true });
      }
    } finally {
      sibling.disconnect();
    }
  }, 90_000);

  it("serializes concurrently emitted ordered envelopes from two sockets of one participant", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    const address = harness.server.address();
    if (!address || typeof address === "string") throw new Error("Test server missing address");
    const sibling = io(`http://127.0.0.1:${address.port}`, { path: "/api/realtime", transports: ["websocket"], auth: { roomId: harness.roomId, guestToken: harness.guestToken } });
    await new Promise<void>((resolve, reject) => { sibling.once("connect", () => resolve()); sibling.once("connect_error", reject); });
    try {
      const results = await Promise.all([
        send(harness.socket, envelope("r".repeat(22), 1)),
        send(sibling, envelope("s".repeat(22), 2)),
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      await expect(send(sibling, envelope("t".repeat(22), 1))).resolves.toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
    } finally {
      sibling.disconnect();
    }
  }, 90_000);

  it("buffers a bounded reverse arrival until its missing predecessor is accepted, then rejects duplicates", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    const address = harness.server.address();
    if (!address || typeof address === "string") throw new Error("Test server missing address");
    const sibling = io(`http://127.0.0.1:${address.port}`, { path: "/api/realtime", transports: ["websocket"], auth: { roomId: harness.roomId, guestToken: harness.guestToken } });
    await new Promise<void>((resolve, reject) => { sibling.once("connect", () => resolve()); sibling.once("connect_error", reject); });
    try {
      const delayedSecond = send(sibling, envelope("v".repeat(22), 2));
      await new Promise(resolve => setTimeout(resolve, 25));
      const first = send(harness.socket, envelope("u".repeat(22), 1));
      await expect(Promise.all([first, delayedSecond])).resolves.toEqual([{ ok: true }, { ok: true }]);
      await expect(send(sibling, envelope("v".repeat(22), 2))).resolves.toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
      await expect(send(harness.socket, envelope("w".repeat(22), 1))).resolves.toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
    } finally {
      sibling.disconnect();
    }
  }, 90_000);

  it("rejects and clears a buffered successor when its predecessor never arrives, then keeps sequencing usable", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    const expiredSecond = await send(harness.socket, envelope("q".repeat(22), 2));
    expect(expiredSecond).toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
    await expect(send(harness.socket, envelope("q".repeat(22), 2))).resolves.toMatchObject({ ok: false, code: "REPLAY_REJECTED" });
    await expect(send(harness.socket, envelope("p".repeat(22), 1))).resolves.toEqual({ ok: true });
    await expect(send(harness.socket, envelope("r".repeat(22), 3))).resolves.toEqual({ ok: true });
  }, 60_000);

  it("keeps same-participant presence online across one socket disconnect and relays transient typing", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    const address = harness.server.address();
    if (!address || typeof address === "string") throw new Error("Test server missing address");
    const sibling = io(`http://127.0.0.1:${address.port}`, { path: "/api/realtime", transports: ["websocket"], auth: { roomId: harness.roomId, guestToken: harness.guestToken } });
    await new Promise<void>((resolve, reject) => { sibling.once("connect", () => resolve()); sibling.once("connect_error", reject); });
    try {
      const typing = new Promise<{ isTyping: boolean }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Typing event timed out")), 3_000);
        sibling.once("room:typing", payload => { clearTimeout(timeout); resolve(payload); });
      });
      harness.socket.emit("room:typing", { isTyping: true });
      await expect(typing).resolves.toEqual({ isTyping: true });
      const stillOnline = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Presence event timed out")), 3_000);
        harness.socket.once("room:presence", payload => { clearTimeout(timeout); resolve(payload.onlineParticipantCount); });
      });
      sibling.disconnect();
      await expect(stillOnline).resolves.toBe(1);
    } finally {
      sibling.disconnect();
    }
  }, 90_000);

  it("rejects an oversized encrypted envelope before room processing and keeps the relay usable", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    await expect(send(harness.socket, { ...envelope("z".repeat(22), 1), ciphertext: "x".repeat(11_500) })).resolves.toMatchObject({ ok: false, code: "INVALID_ENVELOPE" });
    await expect(send(harness.socket, envelope("y".repeat(22), 1))).resolves.toEqual({ ok: true });
  }, 60_000);

  it("does not resurrect an expired room through an already-authenticated socket", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    const db = await getDb();
    await db!.update(rooms).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(rooms.roomId, harness.roomId));
    await expect(send(harness.socket, envelope("e".repeat(22), 1))).resolves.toMatchObject({ ok: false, code: "ROOM_EXPIRED" });
  }, 60_000);

  it("notifies and disconnects active sockets when a host burns the room", async () => {
    const harness = await startRelay();
    harnesses.push(harness);
    const terminalError = new Promise<{ code: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Burn notification timed out")), 3_000);
      harness.socket.once("room:error", payload => { clearTimeout(timeout); resolve(payload); });
    });
    const disconnected = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Burn disconnect timed out")), 3_000);
      harness.socket.once("disconnect", () => { clearTimeout(timeout); resolve(); });
    });
    closeBurnedRoomSockets(harness.roomId);
    await expect(terminalError).resolves.toMatchObject({ code: "ROOM_EXPIRED" });
    await expect(disconnected).resolves.toBeUndefined();
  }, 60_000);
});
