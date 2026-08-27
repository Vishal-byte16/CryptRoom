import { describe, expect, it } from "vitest";
import { roomParticipants, rooms } from "../drizzle/schema";
import {
  AES_GCM_IV_BASE64URL_LENGTH,
  MESSAGE_ID_LENGTH,
  canJoinRoom,
  hasValidGuestToken,
  hasValidSecretVerifier,
  isRoomEmpty,
  isValidEncryptedEnvelope,
  isValidRoomId,
  normalizeRoomId,
  ROOM_LIFETIME_MS,
} from "./roomPolicy";
import { createExpectedJoinProof, matchesJoinProof } from "./roomSecretProof";
import { getRequestIp } from "./rooms";

describe("CryptRoom security policy", () => {
  it("normalizes and validates only the permitted room ID alphabet", () => {
    expect(normalizeRoomId(" k7-x9 p2 ")).toBe("K7X9P2");
    expect(isValidRoomId("K7X9P2")).toBe(true);
    expect(isValidRoomId("O0I1AB")).toBe(false);
  });

  it("accepts only high-entropy guest tokens and room-secret verifiers", () => {
    expect(hasValidGuestToken("a".repeat(43))).toBe(true);
    expect(hasValidGuestToken("short-token")).toBe(false);
    expect(hasValidSecretVerifier("a".repeat(43))).toBe(true);
    expect(hasValidSecretVerifier("a".repeat(42))).toBe(false);
  });

  it("validates proof of room-secret possession without accepting a different proof", () => {
    const verifier = "a".repeat(43);
    const proof = createExpectedJoinProof(verifier, "K7X9P2", "b".repeat(32), "c".repeat(43));
    expect(matchesJoinProof(proof, proof)).toBe(true);
    expect(matchesJoinProof(proof, `${proof.slice(0, -1)}A`)).toBe(false);
  });

  it("accepts only bounded, authenticated encrypted envelopes", () => {
    const now = Date.now();
    const valid = { messageId: "a".repeat(MESSAGE_ID_LENGTH), sequence: 1, ciphertext: "b".repeat(24), iv: "c".repeat(AES_GCM_IV_BASE64URL_LENGTH), sentAt: now };
    expect(isValidEncryptedEnvelope(valid, now)).toBe(true);
    expect(isValidEncryptedEnvelope({ ...valid, ciphertext: "" }, now)).toBe(false);
    expect(isValidEncryptedEnvelope({ ...valid, iv: "nonce" }, now)).toBe(false);
    expect(isValidEncryptedEnvelope({ ...valid, sequence: 0 }, now)).toBe(false);
    expect(isValidEncryptedEnvelope({ ...valid, sentAt: now + 6 * 60_000 }, now)).toBe(false);
  });

  it("keeps the configured room lifetime finite and capacity fixed at two", () => {
    expect(ROOM_LIFETIME_MS).toBe(30 * 60 * 1000);
    expect(canJoinRoom(0)).toBe(true);
    expect(canJoinRoom(1)).toBe(true);
    expect(canJoinRoom(2)).toBe(false);
    expect(isRoomEmpty(0)).toBe(true);
  });

  it("does not trust a caller-provided forwarding header for abuse controls", () => {
    expect(getRequestIp({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" }, "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("CryptRoom privacy data model", () => {
  it("persists operational room and participant metadata but no message body or plaintext room secret", () => {
    const columns = [...Object.keys(rooms), ...Object.keys(roomParticipants)].map(column => column.toLowerCase());
    expect(columns.some(column => column.includes("message") || column.includes("cipher") || column.includes("plaintext"))).toBe(false);
    expect(Object.keys(rooms)).toEqual(expect.arrayContaining(["roomId", "secretVerifier", "expiresAt"]));
    expect(Object.keys(roomParticipants)).toEqual(expect.arrayContaining(["participantTokenHash", "connectionState", "leftAt"]));
  });
});
