import { boolean, index, int, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Legacy account data from the original scaffold. CryptRoom never reads or
 * writes this table; it remains declared only to prevent an unreviewed,
 * destructive migration from deleting potentially personal data.
 */
export const legacyUsers = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

/**
 * Operational room metadata only. The secret verifier cannot recover the room
 * secret; chat plaintext, ciphertext, and histories are intentionally absent.
 */
export const rooms = mysqlTable(
  "rooms",
  {
    id: int("id").autoincrement().primaryKey(),
    roomId: varchar("roomId", { length: 6 }).notNull(),
    secretVerifier: varchar("secretVerifier", { length: 43 }).notNull().default(""),
    activeParticipantCount: int("activeParticipantCount").default(0).notNull(),
    status: mysqlEnum("status", ["active", "closed", "expired"]).default("active").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastActivity: timestamp("lastActivity").defaultNow().onUpdateNow().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
  },
  table => ({
    roomIdUnique: uniqueIndex("rooms_room_id_unique").on(table.roomId),
    expiresAtIndex: index("rooms_expires_at_idx").on(table.expiresAt),
  })
);

/** Raw guest tokens are never persisted; only a SHA-256 token verifier is stored. */
export const roomParticipants = mysqlTable(
  "room_participants",
  {
    id: int("id").autoincrement().primaryKey(),
    roomId: int("roomId").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    participantTokenHash: varchar("participantTokenHash", { length: 64 }).notNull(),
    isHost: boolean("isHost").default(false).notNull(),
    connectionState: mysqlEnum("connectionState", ["online", "offline"]).default("offline").notNull(),
    joinedAt: timestamp("joinedAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().onUpdateNow().notNull(),
    leftAt: timestamp("leftAt"),
  },
  table => ({
    participantTokenUnique: uniqueIndex("participants_token_hash_unique").on(table.participantTokenHash),
    roomActiveIndex: index("participants_room_active_idx").on(table.roomId, table.leftAt),
  })
);

/** A short-lived public challenge; it does not contain a room secret or encryption key. */
export const roomJoinChallenges = mysqlTable(
  "room_join_challenges",
  {
    id: int("id").autoincrement().primaryKey(),
    roomId: int("roomId").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    challengeId: varchar("challengeId", { length: 32 }).notNull(),
    challenge: varchar("challenge", { length: 43 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
  },
  table => ({
    challengeIdUnique: uniqueIndex("join_challenges_id_unique").on(table.challengeId),
    roomIdUnique: uniqueIndex("join_challenges_room_id_unique").on(table.roomId),
    expiresAtIndex: index("join_challenges_expires_at_idx").on(table.expiresAt),
  })
);

export type Room = typeof rooms.$inferSelect;
export type RoomParticipant = typeof roomParticipants.$inferSelect;
