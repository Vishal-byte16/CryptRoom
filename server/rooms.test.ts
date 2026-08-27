import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { roomJoinChallenges, rooms } from "../drizzle/schema";
import { getDb } from "./db";
import { burnRoom, cleanupExpiredRooms, beginRoomJoin, completeRoomJoin, createRoom, getRoomAccess, getRoomSnapshot, leaveRoom } from "./rooms";
import { createExpectedJoinProof } from "./roomSecretProof";

function verifierFromSecret(secret: string) {
  return createHash("sha256").update(`CryptRoom/v2/verifier/${secret}`).digest("base64url");
}

async function makeRoom(label: string) {
  const secret = randomBytes(24).toString("base64url");
  const room = await createRoom(`${label}-${Date.now()}-${randomBytes(3).toString("hex")}`, verifierFromSecret(secret));
  return { ...room, secret };
}

async function joinWithSecret(room: { roomId: string; secret: string }, label: string) {
  const challenge = await beginRoomJoin(room.roomId, `${label}-${Date.now()}-${randomBytes(3).toString("hex")}`);
  const proof = createExpectedJoinProof(verifierFromSecret(room.secret), room.roomId, challenge.challengeId, challenge.challenge);
  return completeRoomJoin(room.roomId, challenge.challengeId, proof, `${label}-complete-${Date.now()}-${randomBytes(3).toString("hex")}`);
}

describe("room proof, lifecycle, and persistence controls", () => {
  const accesses: Array<{ roomId: string; guestToken: string }> = [];

  afterEach(async () => {
    await Promise.all(accesses.splice(0).map(access => leaveRoom(access.roomId, access.guestToken).catch(() => undefined)));
  });

  it("creates host access without storing room secrets or chat messages", async () => {
    const room = await makeRoom("create");
    accesses.push(room);
    const access = await getRoomAccess(room.roomId, room.guestToken);
    const snapshot = await getRoomSnapshot(room.roomId, room.guestToken);
    const db = await getDb();
    const persisted = await db!.select().from(rooms).where(eq(rooms.roomId, room.roomId));

    expect(access).toMatchObject({ roomId: room.roomId, isHost: true });
    expect(snapshot).toMatchObject({ activeParticipantCount: 1 });
    expect(persisted[0]?.secretVerifier).toBe(verifierFromSecret(room.secret));
    expect(Object.keys(persisted[0] ?? {})).not.toEqual(expect.arrayContaining(["secret", "message", "ciphertext", "plaintext"]));
  }, 60_000);

  it("rejects wrong, missing, and malformed proofs even when the Room ID is known", async () => {
    const room = await makeRoom("proof");
    accesses.push(room);
    const challenge = await beginRoomJoin(room.roomId, `proof-begin-${Date.now()}`);
    await expect(completeRoomJoin(room.roomId, challenge.challengeId, "z".repeat(43), `proof-wrong-${Date.now()}`)).rejects.toThrow("unavailable");
    await expect(completeRoomJoin(room.roomId, challenge.challengeId, "", `proof-empty-${Date.now()}`)).rejects.toThrow("unavailable");
    await expect(completeRoomJoin(room.roomId, "bad", "x".repeat(43), `proof-bad-${Date.now()}`)).rejects.toThrow("unavailable");
  });

  it("allows a correct proof exactly once and rejects third-participant admission", async () => {
    const host = await makeRoom("capacity");
    accesses.push(host);
    const guest = await joinWithSecret(host, "capacity-guest");
    accesses.push(guest);
    await expect(joinWithSecret(host, "capacity-third")).rejects.toThrow("unavailable");
    const guestLeave = await leaveRoom(guest.roomId, guest.guestToken);
    const hostLeave = await leaveRoom(host.roomId, host.guestToken);
    expect(guestLeave.deleted).toBe(false);
    expect(hostLeave.deleted).toBe(true);
  }, 60_000);

  it("allows only the host to burn an active room early", async () => {
    const host = await makeRoom("burn");
    accesses.push(host);
    const guest = await joinWithSecret(host, "burn-guest");
    accesses.push(guest);
    await expect(burnRoom(guest.roomId, guest.guestToken)).rejects.toThrow("unavailable");
    await expect(burnRoom(host.roomId, host.guestToken)).resolves.toMatchObject({ roomId: host.roomId, burned: true });
    await expect(getRoomAccess(host.roomId, host.guestToken)).resolves.toBeUndefined();
    await expect(getRoomAccess(guest.roomId, guest.guestToken)).resolves.toBeUndefined();
  }, 60_000);

  it("replaces stale join challenges and permits only one participant in the final room slot", async () => {
    const host = await makeRoom("concurrent");
    accesses.push(host);
    const first = await beginRoomJoin(host.roomId, `concurrent-a-${Date.now()}`);
    const second = await beginRoomJoin(host.roomId, `concurrent-b-${Date.now()}`);
    const verifier = verifierFromSecret(host.secret);
    await expect(completeRoomJoin(host.roomId, first.challengeId, createExpectedJoinProof(verifier, host.roomId, first.challengeId, first.challenge), `concurrent-a-complete-${Date.now()}`)).rejects.toThrow("unavailable");
    const guest = await completeRoomJoin(host.roomId, second.challengeId, createExpectedJoinProof(verifier, host.roomId, second.challengeId, second.challenge), `concurrent-b-complete-${Date.now()}`);
    accesses.push(guest);
  }, 60_000);

  it("atomically retains exactly one newest usable challenge across 50 concurrent requests", async () => {
    const host = await makeRoom("challenge-race");
    accesses.push(host);
    const verifier = verifierFromSecret(host.secret);
    const challenges = await Promise.all(
      Array.from({ length: 50 }, (_, index) => beginRoomJoin(host.roomId, `challenge-race-${index}-${Date.now()}-${randomBytes(3).toString("hex")}`))
    );
    const db = await getDb();
    const access = await getRoomAccess(host.roomId, host.guestToken);
    const persisted = await db!.select().from(roomJoinChallenges).where(eq(roomJoinChallenges.roomId, access!.roomDbId));

    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const newest = challenges.find(challenge => challenge.challengeId === persisted[0]!.challengeId);
    expect(newest).toBeDefined();

    const obsolete = challenges.find(challenge => challenge.challengeId !== newest!.challengeId)!;
    await expect(
      completeRoomJoin(host.roomId, obsolete.challengeId, createExpectedJoinProof(verifier, host.roomId, obsolete.challengeId, obsolete.challenge), `challenge-race-old-${Date.now()}`)
    ).rejects.toThrow("unavailable");

    const guest = await completeRoomJoin(host.roomId, newest!.challengeId, createExpectedJoinProof(verifier, host.roomId, newest!.challengeId, newest!.challenge), `challenge-race-new-${Date.now()}`);
    accesses.push(guest);
    await expect(
      completeRoomJoin(host.roomId, newest!.challengeId, createExpectedJoinProof(verifier, host.roomId, newest!.challengeId, newest!.challenge), `challenge-race-replay-${Date.now()}`)
    ).rejects.toThrow("unavailable");
    expect(await db!.select().from(roomJoinChallenges).where(eq(roomJoinChallenges.roomId, access!.roomDbId))).toHaveLength(0);
  }, 60_000);

  it("removes expired rooms and their transient challenges idempotently", async () => {
    const room = await makeRoom("expiry");
    accesses.push(room);
    const challenge = await beginRoomJoin(room.roomId, `expiry-begin-${Date.now()}`);
    const db = await getDb();
    const access = await getRoomAccess(room.roomId, room.guestToken);
    await db!.update(rooms).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(rooms.id, access!.roomDbId));
    expect(await cleanupExpiredRooms()).toBeGreaterThanOrEqual(1);
    expect(await cleanupExpiredRooms()).toBeGreaterThanOrEqual(0);
    expect(await db!.select().from(roomJoinChallenges).where(eq(roomJoinChallenges.challengeId, challenge.challengeId))).toHaveLength(0);
    await expect(getRoomAccess(room.roomId, room.guestToken)).resolves.toBeUndefined();
  });
});
