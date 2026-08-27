import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { roomJoinChallenges, roomParticipants, rooms } from "../drizzle/schema";
import { getDb } from "./db";
import { BoundedRateLimiter } from "./rateLimit";
import {
  canJoinRoom,
  hasValidGuestToken,
  hasValidJoinChallengeId,
  hasValidSecretVerifier,
  isExpired,
  isRoomEmpty,
  isValidRoomId,
  JOIN_CHALLENGE_LIFETIME_MS,
  MAX_PARTICIPANTS,
  normalizeRoomId,
  ROOM_ID_LENGTH,
  ROOM_LIFETIME_MS,
  safeRoomErrorMessage,
} from "./roomPolicy";
import { createExpectedJoinProof, matchesJoinProof } from "./roomSecretProof";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GUEST_TOKEN_BYTES = 32;
const CHALLENGE_BYTES = 32;
const CHALLENGE_ID_BYTES = 24;
const rateLimiters = {
  create: new BoundedRateLimiter(6, 60_000, 2_048),
  join: new BoundedRateLimiter(12, 60_000, 4_096),
};

export type RoomAccess = {
  roomDbId: number;
  roomId: string;
  participantId: number;
  isHost: boolean;
  expiresAt: Date;
  activeParticipantCount: number;
};

function changedRows(result: unknown): number {
  return Number((result as Array<{ affectedRows?: number }>)[0]?.affectedRows ?? 0);
}

function insertedId(result: unknown): number {
  return Number((result as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function issueGuestToken(): string {
  return randomBytes(GUEST_TOKEN_BYTES).toString("base64url");
}

function generateRoomId(): string {
  return Array.from({ length: ROOM_ID_LENGTH }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join("");
}

function issueChallenge() {
  return {
    challengeId: randomBytes(CHALLENGE_ID_BYTES).toString("base64url"),
    challenge: randomBytes(CHALLENGE_BYTES).toString("base64url"),
  };
}

export function getRequestIp(_headers: { [key: string]: string | string[] | undefined }, fallback?: string): string {
  // Express controls req.ip using the explicitly configured trust-proxy policy.
  return fallback?.slice(0, 128) || "unknown";
}

export function assertRateLimit(action: keyof typeof rateLimiters, requesterIp: string) {
  if (!rateLimiters[action].consume(requesterIp)) {
    throw new Error("Too many requests. Please wait a moment and try again.");
  }
}

export async function cleanupExpiredRooms(): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  const now = new Date();
  await db.delete(roomJoinChallenges).where(lt(roomJoinChallenges.expiresAt, now));
  const result = await db.delete(rooms).where(lt(rooms.expiresAt, now));
  return changedRows(result);
}

async function getActiveRoom(roomId: string) {
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  const result = await db.select().from(rooms).where(and(eq(rooms.roomId, roomId), eq(rooms.status, "active"))).limit(1);
  const room = result[0];
  if (!room || !hasValidSecretVerifier(room.secretVerifier)) return undefined;
  if (isExpired(room.expiresAt)) {
    await db.delete(rooms).where(eq(rooms.id, room.id));
    return undefined;
  }
  return room;
}

export async function createRoom(requesterIp: string, secretVerifier: string) {
  assertRateLimit("create", requesterIp);
  if (!hasValidSecretVerifier(secretVerifier)) throw new Error("Could not create a secure room. Please try again.");
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ROOM_LIFETIME_MS);
  const guestToken = issueGuestToken();
  const participantTokenHash = hashValue(guestToken);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const roomId = generateRoomId();
    try {
      const created = await db.transaction(async tx => {
        const roomResult = await tx.insert(rooms).values({
          roomId,
          secretVerifier,
          activeParticipantCount: 1,
          status: "active",
          createdAt: now,
          lastActivity: now,
          expiresAt,
        });
        const roomDbId = insertedId(roomResult);
        if (!roomDbId) throw new Error("Room creation did not return an identifier.");
        const participantResult = await tx.insert(roomParticipants).values({
          roomId: roomDbId,
          participantTokenHash,
          isHost: true,
          connectionState: "offline",
          joinedAt: now,
          lastSeenAt: now,
        });
        const participantId = insertedId(participantResult);
        if (!participantId) throw new Error("Participant creation did not return an identifier.");
        return { participantId };
      });
      return { roomId, guestToken, isHost: true, expiresAt, participantId: created.participantId };
    } catch (error) {
      if (attempt === 7) throw error;
    }
  }
  throw new Error("Could not create a unique room. Please try again.");
}

export async function beginRoomJoin(rawRoomId: string, requesterIp: string) {
  assertRateLimit("join", requesterIp);
  const roomId = normalizeRoomId(rawRoomId);
  if (!isValidRoomId(roomId)) throw new Error(safeRoomErrorMessage());
  const room = await getActiveRoom(roomId);
  if (!room || !canJoinRoom(room.activeParticipantCount)) throw new Error(safeRoomErrorMessage());
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");

  const { challengeId, challenge } = issueChallenge();
  const now = new Date();
  // The unique roomId index makes replacement a single atomic database operation.
  // A concurrent request can only replace the row; it cannot create a second active challenge.
  await db.insert(roomJoinChallenges).values({
    roomId: room.id,
    challengeId,
    challenge,
    createdAt: now,
    expiresAt: new Date(now.getTime() + JOIN_CHALLENGE_LIFETIME_MS),
  }).onDuplicateKeyUpdate({
    set: {
      challengeId,
      challenge,
      createdAt: now,
      expiresAt: new Date(now.getTime() + JOIN_CHALLENGE_LIFETIME_MS),
    },
  });
  return { challengeId, challenge, expiresAt: new Date(now.getTime() + JOIN_CHALLENGE_LIFETIME_MS) };
}

export async function completeRoomJoin(rawRoomId: string, challengeId: string, proof: string, requesterIp: string) {
  assertRateLimit("join", requesterIp);
  const roomId = normalizeRoomId(rawRoomId);
  if (!isValidRoomId(roomId) || !hasValidJoinChallengeId(challengeId)) throw new Error(safeRoomErrorMessage());
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  const now = new Date();

  const rows = await db
    .select({
      challengeDbId: roomJoinChallenges.id,
      challenge: roomJoinChallenges.challenge,
      challengeExpiresAt: roomJoinChallenges.expiresAt,
      roomDbId: rooms.id,
      roomId: rooms.roomId,
      secretVerifier: rooms.secretVerifier,
      activeParticipantCount: rooms.activeParticipantCount,
      roomExpiresAt: rooms.expiresAt,
      status: rooms.status,
    })
    .from(roomJoinChallenges)
    .innerJoin(rooms, eq(roomJoinChallenges.roomId, rooms.id))
    .where(and(eq(roomJoinChallenges.challengeId, challengeId), eq(rooms.roomId, roomId)))
    .limit(1);
  const record = rows[0];
  if (!record || record.status !== "active" || isExpired(record.challengeExpiresAt, now) || isExpired(record.roomExpiresAt, now)) {
    throw new Error(safeRoomErrorMessage());
  }
  if (!hasValidSecretVerifier(record.secretVerifier)) throw new Error(safeRoomErrorMessage());
  const expectedProof = createExpectedJoinProof(record.secretVerifier, roomId, challengeId, record.challenge);
  if (!matchesJoinProof(expectedProof, proof)) throw new Error(safeRoomErrorMessage());

  const guestToken = issueGuestToken();
  const participantTokenHash = hashValue(guestToken);
  const joined = await db.transaction(async tx => {
    const consumed = await tx
      .delete(roomJoinChallenges)
      .where(and(eq(roomJoinChallenges.id, record.challengeDbId), gt(roomJoinChallenges.expiresAt, now)));
    if (changedRows(consumed) !== 1) throw new Error(safeRoomErrorMessage());

    const increment = await tx
      .update(rooms)
      .set({ activeParticipantCount: sql`${rooms.activeParticipantCount} + 1`, lastActivity: now })
      .where(and(eq(rooms.id, record.roomDbId), eq(rooms.status, "active"), sql`${rooms.activeParticipantCount} < ${MAX_PARTICIPANTS}`, sql`${rooms.expiresAt} > ${now}`));
    if (changedRows(increment) !== 1) throw new Error(safeRoomErrorMessage());

    const participantResult = await tx.insert(roomParticipants).values({
      roomId: record.roomDbId,
      participantTokenHash,
      isHost: false,
      connectionState: "offline",
      joinedAt: now,
      lastSeenAt: now,
    });
    const participantId = insertedId(participantResult);
    if (!participantId) throw new Error("Room access could not be established.");
    return { participantId };
  });

  return { roomId, guestToken, isHost: false, expiresAt: record.roomExpiresAt, participantId: joined.participantId };
}

export async function getRoomAccess(rawRoomId: string, guestToken: string): Promise<RoomAccess | undefined> {
  const roomId = normalizeRoomId(rawRoomId);
  if (!isValidRoomId(roomId) || !hasValidGuestToken(guestToken)) return undefined;
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  const participantTokenHash = hashValue(guestToken);
  const accessRows = await db
    .select({ roomDbId: rooms.id, roomId: rooms.roomId, participantId: roomParticipants.id, isHost: roomParticipants.isHost, expiresAt: rooms.expiresAt, activeParticipantCount: rooms.activeParticipantCount })
    .from(roomParticipants)
    .innerJoin(rooms, eq(roomParticipants.roomId, rooms.id))
    .where(and(eq(rooms.roomId, roomId), eq(rooms.status, "active"), eq(roomParticipants.participantTokenHash, participantTokenHash), isNull(roomParticipants.leftAt)))
    .limit(1);
  const access = accessRows[0];
  if (!access || isExpired(access.expiresAt)) {
    if (access) await db.delete(rooms).where(eq(rooms.id, access.roomDbId));
    return undefined;
  }
  return access;
}

export async function getRoomSnapshot(rawRoomId: string, guestToken: string) {
  const access = await getRoomAccess(rawRoomId, guestToken);
  if (!access) throw new Error(safeRoomErrorMessage());
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  const now = new Date();
  await db.update(roomParticipants).set({ lastSeenAt: now }).where(eq(roomParticipants.id, access.participantId));
  await db.update(rooms).set({ lastActivity: now }).where(eq(rooms.id, access.roomDbId));
  return { roomId: access.roomId, isHost: access.isHost, activeParticipantCount: access.activeParticipantCount, expiresAt: access.expiresAt };
}

export async function setParticipantConnection(rawRoomId: string, guestToken: string, connectionState: "online" | "offline") {
  const access = await getRoomAccess(rawRoomId, guestToken);
  if (!access) return undefined;
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  const now = new Date();
  await db.update(roomParticipants).set({ connectionState, lastSeenAt: now }).where(eq(roomParticipants.id, access.participantId));
  return access;
}

export async function touchRoom(rawRoomId: string, guestToken: string) {
  const access = await getRoomAccess(rawRoomId, guestToken);
  if (!access) return undefined;
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  await db.update(rooms).set({ lastActivity: new Date() }).where(eq(rooms.id, access.roomDbId));
  return access;
}

/** Destroys an active room early after authenticating the persisted host participant. */
export async function burnRoom(rawRoomId: string, guestToken: string) {
  const access = await getRoomAccess(rawRoomId, guestToken);
  if (!access || !access.isHost) throw new Error(safeRoomErrorMessage());
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  await db.delete(rooms).where(and(eq(rooms.id, access.roomDbId), eq(rooms.status, "active")));
  return { roomId: access.roomId, burned: true };
}

export async function leaveRoom(rawRoomId: string, guestToken: string) {
  const access = await getRoomAccess(rawRoomId, guestToken);
  if (!access) return { deleted: false, roomId: normalizeRoomId(rawRoomId) };
  const db = await getDb();
  if (!db) throw new Error("Room service is temporarily unavailable.");
  const now = new Date();
  const didLeave = await db.update(roomParticipants).set({ connectionState: "offline", leftAt: now, lastSeenAt: now }).where(and(eq(roomParticipants.id, access.participantId), isNull(roomParticipants.leftAt)));
  if (changedRows(didLeave) !== 1) return { deleted: false, roomId: access.roomId };
  await db.update(rooms).set({ activeParticipantCount: sql`GREATEST(${rooms.activeParticipantCount} - 1, 0)`, lastActivity: now }).where(eq(rooms.id, access.roomDbId));
  const remaining = await db.select({ count: rooms.activeParticipantCount }).from(rooms).where(eq(rooms.id, access.roomDbId)).limit(1);
  const deleted = isRoomEmpty(Number(remaining[0]?.count ?? -1));
  if (deleted) await db.delete(rooms).where(eq(rooms.id, access.roomDbId));
  return { deleted, roomId: access.roomId };
}
