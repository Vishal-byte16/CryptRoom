import type { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import { isIP } from "node:net";
import { BoundedRateLimiter } from "./rateLimit";
import { isValidEncryptedEnvelope, type CiphertextEnvelope } from "./roomPolicy";
import { getRoomAccess, setParticipantConnection, touchRoom, type RoomAccess } from "./rooms";

export type MessageAck =
  | { ok: true }
  | { ok: false; code: "RATE_LIMITED" | "INVALID_ENVELOPE" | "REPLAY_REJECTED" | "ROOM_EXPIRED" | "UNAUTHORIZED" | "INVALID_STATE" | "SERVER_ERROR"; message: string };

type RoomMessageEvent = { envelope: CiphertextEnvelope; own: boolean };

type ClientToServerEvents = {
  "room:message": (payload: CiphertextEnvelope, acknowledge?: (result: MessageAck) => void) => void;
  "room:typing": (payload: { isTyping: boolean }) => void;
};

type ServerToClientEvents = {
    "room:message": (payload: RoomMessageEvent) => void;
    "room:presence": (payload: { onlineParticipantCount: number }) => void;
    "room:typing": (payload: { isTyping: boolean }) => void;
    "room:error": (payload: Exclude<MessageAck, { ok: true }>) => void;
};

type RoomSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  { roomId?: string; roomDbId?: number; guestToken?: string; participantId?: number; expiresAt?: number }
>;

type DeferredMessage = { sequence: number; onAccept: () => void; onReject: () => void; timer: ReturnType<typeof setTimeout> };
type ReplayState = { messageIds: Map<string, number>; pending: Map<number, DeferredMessage>; rejectedSequences: Map<number, number>; lastSequence: number; lastTouched: number };
const messageLimiter = new BoundedRateLimiter(24, 10_000, 8_192);
const typingLimiter = new BoundedRateLimiter(18, 10_000, 8_192);
const handshakeLimiter = new BoundedRateLimiter(30, 60_000, 8_192);
const replayStates = new Map<string, ReplayState>();
const participantSockets = new Map<string, Map<number, Set<string>>>();
const REPLAY_TTL_MS = 40 * 60 * 1000;
const MAX_REPLAY_STATES = 2_048;
const MAX_IDS_PER_PARTICIPANT = 256;
const MAX_OUT_OF_ORDER_SEQUENCE_GAP = 16;
const MAX_DEFERRED_MESSAGES_PER_PARTICIPANT = 16;
const configuredOrderingTimeout = Number.parseInt(process.env.OUT_OF_ORDER_TIMEOUT_MS ?? "", 10);
const OUT_OF_ORDER_TIMEOUT_MS = Number.isSafeInteger(configuredOrderingTimeout)
  ? Math.min(Math.max(configuredOrderingTimeout, 50), 10_000)
  : process.env.NODE_ENV === "test" ? 80 : 3_000;
const MAX_PARTICIPANT_QUEUES = 2_048;
const MAX_PENDING_MESSAGES_PER_PARTICIPANT = 32;
type ParticipantQueue = { chain: Promise<void>; pending: number };
const participantQueues = new Map<string, ParticipantQueue>();
let activeRelay: Server | null = null;
const burnedRoomIds = new Set<string>();

export function allowedSocketOrigin(origin: string | undefined, nodeEnv = process.env.NODE_ENV, configuredOrigins = process.env.ALLOWED_ORIGINS ?? process.env.ALLOWED_HOSTS ?? "", host?: string) {
  if (nodeEnv !== "production") return true;
  const configured = configuredOrigins.split(",").map(value => value.trim()).filter(Boolean);
  if (configured.length === 0) {
    console.warn("[roomRelay] Rejected socket connection: no ALLOWED_ORIGINS configured.");
    return false;
  }
  if (!origin) {
    // Some same-origin XHR polling requests omit the Origin header. Fall back to
    // checking the Host header against the allowed origins' host component.
    const allowedHosts = configured.map(value => { try { return new URL(value).host; } catch { return null; } }).filter(Boolean);
    const allowed = !!host && allowedHosts.includes(host);
    if (!allowed) console.warn(`[roomRelay] Rejected socket request with no Origin header. Host: "${host ?? "(none)"}". Allowed hosts: ${allowedHosts.join(", ") || "(none)"}`);
    return allowed;
  }
  try {
    const allowed = configured.includes(new URL(origin).origin);
    if (!allowed) console.warn(`[roomRelay] Rejected socket origin "${origin}". Allowed: ${configured.join(", ") || "(none configured)"}`);
    return allowed;
  } catch {
    console.warn(`[roomRelay] Rejected socket origin "${origin}": failed to parse as URL.`);
    return false;
  }
}

/** Stable server-derived key shared by every socket belonging to one participant. */
export function participantRateLimitKey(access: Pick<RoomAccess, "roomDbId" | "participantId">) {
  return `${access.roomDbId}:${access.participantId}`;
}

/**
 * TRUST_PROXY=1 is supported only when the application is reachable through one
 * network-restricted trusted proxy that overwrites X-Forwarded-For. Direct
 * deployments always rate-limit the nonspoofable transport peer address.
 */
export function handshakeClientIdentity(handshake: Pick<Socket["handshake"], "address" | "headers">, trustProxy = process.env.TRUST_PROXY === "1"): string {
  const peerAddress = String(handshake.address ?? "unknown").slice(0, 128);
  if (!trustProxy) return peerAddress;
  const forwarded = handshake.headers["x-forwarded-for"];
  const candidate = (Array.isArray(forwarded) ? forwarded[0] : forwarded ?? "").split(",")[0].trim();
  return isIP(candidate) ? candidate : peerAddress;
}

function roomChannel(roomId: string) {
  return `room:${roomId}`;
}

/** Broadcasts a safe terminal state and closes active sockets for an already-destroyed room. */
export function closeBurnedRoomSockets(roomId: string) {
  if (!activeRelay) return;
  burnedRoomIds.add(roomId);
  activeRelay.to(roomChannel(roomId)).emit("room:error", { ok: false, code: "ROOM_EXPIRED", message: "This room was burned by its host." });
  participantSockets.delete(roomId);
  setTimeout(() => {
    activeRelay?.in(roomChannel(roomId)).disconnectSockets(true);
    burnedRoomIds.delete(roomId);
  }, 80);
}

function socketMap(roomId: string) {
  let entries = participantSockets.get(roomId);
  if (!entries) {
    entries = new Map();
    participantSockets.set(roomId, entries);
  }
  return entries;
}

function addConnection(roomId: string, participantId: number, socketId: string) {
  const participants = socketMap(roomId);
  let sockets = participants.get(participantId);
  const firstConnection = !sockets;
  if (!sockets) {
    sockets = new Set();
    participants.set(participantId, sockets);
  }
  sockets.add(socketId);
  return firstConnection;
}

function removeConnection(roomId: string, participantId: number, socketId: string) {
  const participants = participantSockets.get(roomId);
  const sockets = participants?.get(participantId);
  if (!participants || !sockets) return false;
  sockets.delete(socketId);
  if (sockets.size > 0) return false;
  participants.delete(participantId);
  if (participants.size === 0) participantSockets.delete(roomId);
  return true;
}

function onlineParticipants(roomId: string) {
  return participantSockets.get(roomId)?.size ?? 0;
}

function emitPresence(io: Server, roomId: string) {
  io.to(roomChannel(roomId)).emit("room:presence", { onlineParticipantCount: onlineParticipants(roomId) });
}

function queueParticipantMessage(key: string, task: () => Promise<void>) {
  let queue = participantQueues.get(key);
  if (!queue) {
    if (participantQueues.size >= MAX_PARTICIPANT_QUEUES) return false;
    queue = { chain: Promise.resolve(), pending: 0 };
    participantQueues.set(key, queue);
  }
  if (queue.pending >= MAX_PENDING_MESSAGES_PER_PARTICIPANT) return false;
  queue.pending += 1;
  queue.chain = queue.chain.then(task).catch(() => undefined).finally(() => {
    queue!.pending -= 1;
    if (queue!.pending === 0) participantQueues.delete(key);
  });
  return true;
}

function emitClassifiedMessage(io: Server, roomId: string, senderParticipantId: number, senderSocketId: string, envelope: CiphertextEnvelope) {
  const participants = participantSockets.get(roomId);
  if (!participants) return;
  for (const entry of Array.from(participants.entries())) {
    const participantId = entry[0];
    const socketIds = entry[1];
    const targets = Array.from(socketIds.values()).filter(socketId => socketId !== senderSocketId);
    if (targets.length > 0) io.to(targets).emit("room:message", { envelope, own: participantId === senderParticipantId });
  }
}

function acceptReplayProtectedMessage(access: RoomAccess, envelope: CiphertextEnvelope, onAccept: () => void, onReject: () => void, now = Date.now()) {
  for (const [key, state] of Array.from(replayStates.entries())) {
    if (now - state.lastTouched > REPLAY_TTL_MS) replayStates.delete(key);
  }
  if (replayStates.size >= MAX_REPLAY_STATES && !replayStates.has(`${access.roomDbId}:${access.participantId}`)) {
    const oldest = replayStates.keys().next().value;
    if (oldest) replayStates.delete(oldest);
  }
  const key = `${access.roomDbId}:${access.participantId}`;
  let state = replayStates.get(key);
  if (!state) {
    state = { messageIds: new Map(), pending: new Map(), rejectedSequences: new Map(), lastSequence: 0, lastTouched: now };
    replayStates.set(key, state);
  }
  state.lastTouched = now;
  if (state.messageIds.has(envelope.messageId) || state.pending.has(envelope.sequence) || state.rejectedSequences.has(envelope.sequence) || envelope.sequence <= state.lastSequence) return false;
  if (envelope.sequence > state.lastSequence + MAX_OUT_OF_ORDER_SEQUENCE_GAP || state.pending.size >= MAX_DEFERRED_MESSAGES_PER_PARTICIPANT) return false;
  state.messageIds.set(envelope.messageId, now);
  if (envelope.sequence > state.lastSequence + 1) {
    const timer = setTimeout(() => {
      const pending = state!.pending.get(envelope.sequence);
      if (!pending || pending.sequence !== envelope.sequence) return;
      state!.pending.delete(envelope.sequence);
      state!.rejectedSequences.set(envelope.sequence, Date.now());
      state!.lastTouched = Date.now();
      while (state!.rejectedSequences.size > MAX_IDS_PER_PARTICIPANT) state!.rejectedSequences.delete(state!.rejectedSequences.keys().next().value!);
      pending.onReject();
    }, OUT_OF_ORDER_TIMEOUT_MS);
    state.pending.set(envelope.sequence, { sequence: envelope.sequence, onAccept, onReject, timer });
    return true;
  }
  state.lastSequence = envelope.sequence;
  onAccept();
  while (true) {
    const rejected = state.rejectedSequences.delete(state.lastSequence + 1);
    if (rejected) {
      state.lastSequence += 1;
      continue;
    }
    const next = state.pending.get(state.lastSequence + 1);
    if (!next) break;
    state.pending.delete(next.sequence);
    clearTimeout(next.timer);
    state.lastSequence = next.sequence;
    next.onAccept();
  }
  if (state.messageIds.size > MAX_IDS_PER_PARTICIPANT) {
    const oldestId = state.messageIds.keys().next().value;
    if (oldestId) state.messageIds.delete(oldestId);
  }
  return true;
}

export function registerRoomRelay(server: HttpServer) {
  const io = new Server(server, {
    path: "/api/realtime",
    cors: { origin: false, credentials: false },
    allowRequest: (request, callback) => callback(null, allowedSocketOrigin(request.headers.origin, undefined, undefined, request.headers.host)),
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 12_000,
  });
  activeRelay = io;

  io.use(async (socket, next) => {
    try {
      const handshakeKey = handshakeClientIdentity(socket.handshake);
      if (!handshakeLimiter.consume(handshakeKey)) return next(new Error("Connection rate limit reached."));
      const roomId = typeof socket.handshake.auth.roomId === "string" ? socket.handshake.auth.roomId : "";
      const guestToken = typeof socket.handshake.auth.guestToken === "string" ? socket.handshake.auth.guestToken : "";
      const access = await getRoomAccess(roomId, guestToken);
      if (!access) return next(new Error("Room access is no longer valid."));
      socket.data.roomId = access.roomId;
      socket.data.roomDbId = access.roomDbId;
      socket.data.guestToken = guestToken;
      socket.data.participantId = access.participantId;
      socket.data.expiresAt = access.expiresAt.getTime();
      return next();
    } catch {
      return next(new Error("Unable to verify room access."));
    }
  });

  io.on("connection", async (socket: RoomSocket) => {
    const { roomId, roomDbId, guestToken, participantId, expiresAt } = socket.data;
    if (!roomId || !roomDbId || !guestToken || !participantId || !expiresAt) {
      socket.disconnect(true);
      return;
    }
    socket.join(roomChannel(roomId));
    if (addConnection(roomId, participantId, socket.id)) {
      void setParticipantConnection(roomId, guestToken, "online").finally(() => emitPresence(io, roomId));
    } else {
      emitPresence(io, roomId);
    }

    socket.on("room:message", (payload, acknowledge) => {
      const respond = (result: MessageAck) => {
        if (typeof acknowledge === "function") acknowledge(result);
      };
      const reject = (code: Exclude<MessageAck, { ok: true }> ["code"], message: string) => {
        const result: Exclude<MessageAck, { ok: true }> = { ok: false, code, message };
        respond(result);
        socket.emit("room:error", result);
      };
      if (burnedRoomIds.has(roomId) || Date.now() >= expiresAt) return reject("ROOM_EXPIRED", "This room is no longer active.");
      if (!messageLimiter.consume(`${roomDbId}:${participantId}`)) return reject("RATE_LIMITED", "Message rate limit reached. Please wait a moment.");
      if (!isValidEncryptedEnvelope(payload)) return reject("INVALID_ENVELOPE", "The encrypted message format was rejected.");
      const queueKey = `${roomId}:${participantId}`;
      const queued = queueParticipantMessage(queueKey, async () => {
        try {
          const access = await touchRoom(roomId, guestToken);
          if (!access) return reject("ROOM_EXPIRED", "This room is no longer active.");
          if (!acceptReplayProtectedMessage(access, payload, () => {
            emitClassifiedMessage(io, roomId, participantId, socket.id, payload);
            respond({ ok: true });
          }, () => reject("REPLAY_REJECTED", "This encrypted message expired while waiting for an earlier sequence."))) return reject("REPLAY_REJECTED", "This encrypted message was already used, has an invalid sequence, or exceeds the bounded ordering window.");
        } catch {
          reject("SERVER_ERROR", "The encrypted message could not be processed. Please retry.");
        }
      });
      if (!queued) reject("INVALID_STATE", "Too many pending messages. Please wait a moment.");
    });

    socket.on("room:typing", async payload => {
      if (!payload || typeof payload.isTyping !== "boolean") return;
      if (burnedRoomIds.has(roomId) || Date.now() >= expiresAt) return;
      if (!typingLimiter.consume(`${roomDbId}:${participantId}`)) return;
      socket.to(roomChannel(roomId)).emit("room:typing", { isTyping: payload.isTyping });
    });

    socket.on("disconnect", () => {
      if (removeConnection(roomId, participantId, socket.id)) {
        void setParticipantConnection(roomId, guestToken, "offline").finally(() => emitPresence(io, roomId));
      } else {
        emitPresence(io, roomId);
      }
    });
  });

  return io;
}
