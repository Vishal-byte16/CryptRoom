export const ROOM_ID_LENGTH = 6;
export const ROOM_ID_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
export const ROOM_LIFETIME_MS = 30 * 60 * 1000;
export const JOIN_CHALLENGE_LIFETIME_MS = 90 * 1000;
export const MAX_PARTICIPANTS = 2;
export const MAX_CIPHERTEXT_LENGTH = 8_500;
export const AES_GCM_IV_BASE64URL_LENGTH = 16;
export const SECRET_VERIFIER_LENGTH = 43;
export const JOIN_CHALLENGE_ID_LENGTH = 32;
export const MESSAGE_ID_LENGTH = 22;
export const MAX_MESSAGE_SEQUENCE = 2 ** 31 - 1;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type CiphertextEnvelope = {
  messageId: string;
  sequence: number;
  ciphertext: string;
  iv: string;
  sentAt: number;
};

export function normalizeRoomId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

export function isBase64Url(value: unknown, exactLength?: number): value is string {
  return (
    typeof value === "string" &&
    (exactLength === undefined ? value.length > 0 : value.length === exactLength) &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function hasValidGuestToken(value: unknown): value is string {
  return isBase64Url(value) && value.length >= 32 && value.length <= 128;
}

export function hasValidSecretVerifier(value: unknown): value is string {
  return isBase64Url(value, SECRET_VERIFIER_LENGTH);
}

export function hasValidJoinChallengeId(value: unknown): value is string {
  return isBase64Url(value, JOIN_CHALLENGE_ID_LENGTH);
}

export function canJoinRoom(activeParticipantCount: number): boolean {
  return Number.isInteger(activeParticipantCount) && activeParticipantCount >= 0 && activeParticipantCount < MAX_PARTICIPANTS;
}

export function isRoomEmpty(activeParticipantCount: number): boolean {
  return activeParticipantCount === 0;
}

export function isValidEncryptedEnvelope(value: unknown, now = Date.now()): value is CiphertextEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<CiphertextEnvelope>;
  return (
    isBase64Url(envelope.messageId, MESSAGE_ID_LENGTH) &&
    typeof envelope.sequence === "number" &&
    Number.isInteger(envelope.sequence) &&
    envelope.sequence > 0 &&
    envelope.sequence <= MAX_MESSAGE_SEQUENCE &&
    isBase64Url(envelope.ciphertext) &&
    envelope.ciphertext.length >= 22 &&
    envelope.ciphertext.length <= MAX_CIPHERTEXT_LENGTH &&
    isBase64Url(envelope.iv, AES_GCM_IV_BASE64URL_LENGTH) &&
    typeof envelope.sentAt === "number" &&
    Number.isSafeInteger(envelope.sentAt) &&
    envelope.sentAt >= now - ROOM_LIFETIME_MS - MAX_CLOCK_SKEW_MS &&
    envelope.sentAt <= now + MAX_CLOCK_SKEW_MS
  );
}

export function isExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function safeRoomErrorMessage(): string {
  return "This private room is unavailable or no longer active.";
}
