const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MESSAGE_ID_LENGTH = 22;
const AES_GCM_IV_BASE64URL_LENGTH = 16;
const MAX_CIPHERTEXT_LENGTH = 8_500;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const roomKeyCache = new Map<string, Promise<CryptoKey>>();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function roomKeyContext(roomId: string, secret: string) {
  return `CryptRoom/v2/key/${roomId}/${secret}`;
}

function messageAad(roomId: string, messageId: string, sequence: number, sentAt: number) {
  return encoder.encode(`CryptRoom/v2/message/${roomId}/${messageId}/${sequence}/${sentAt}`);
}

async function deriveRoomKey(roomId: string, secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(roomKeyContext(roomId, secret)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode(`CryptRoom/v2/salt/${roomId}`), iterations: 210_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function cachedRoomKey(roomId: string, secret: string): Promise<CryptoKey> {
  const cacheKey = roomKeyContext(roomId, secret);
  let key = roomKeyCache.get(cacheKey);
  if (!key) {
    key = deriveRoomKey(roomId, secret).catch(error => {
      roomKeyCache.delete(cacheKey);
      throw error;
    });
    roomKeyCache.set(cacheKey, key);
  }
  return key;
}

/** Removes the non-extractable memory-only key when the user explicitly leaves. */
export function clearRoomKeyCache(roomId: string, secret: string) {
  roomKeyCache.delete(roomKeyContext(roomId, secret));
}

export type EncryptedMessage = {
  messageId: string;
  sequence: number;
  ciphertext: string;
  iv: string;
  sentAt: number;
};

/** Client-side defense-in-depth validation; the server remains authoritative. */
export function isValidEncryptedMessageEnvelope(value: unknown, now = Date.now()): value is EncryptedMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.messageId !== "string" || candidate.messageId.length !== MESSAGE_ID_LENGTH || !BASE64URL.test(candidate.messageId)) return false;
  if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 1) return false;
  if (!Number.isFinite(candidate.sentAt) || Math.abs(now - (candidate.sentAt as number)) > MAX_CLOCK_SKEW_MS) return false;
  if (typeof candidate.iv !== "string" || candidate.iv.length !== AES_GCM_IV_BASE64URL_LENGTH || !BASE64URL.test(candidate.iv)) return false;
  return typeof candidate.ciphertext === "string" && candidate.ciphertext.length > 0 && candidate.ciphertext.length <= MAX_CIPHERTEXT_LENGTH && BASE64URL.test(candidate.ciphertext);
}

export function createRoomSecret(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

export function createMessageId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function createRoomSecretVerifier(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`CryptRoom/v2/verifier/${secret}`));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function createRoomJoinProof(roomId: string, secret: string, challengeId: string, challenge: string): Promise<string> {
  const verifier = await createRoomSecretVerifier(secret);
  const key = await crypto.subtle.importKey("raw", base64UrlToBytes(verifier), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = encoder.encode(`CryptRoom/v2/join/${roomId}/${challengeId}/${challenge}`);
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function encryptRoomMessage(roomId: string, secret: string, plaintext: string, sequence: number): Promise<EncryptedMessage> {
  const messageId = createMessageId();
  const sentAt = Date.now();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await cachedRoomKey(roomId, secret);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: messageAad(roomId, messageId, sequence, sentAt) }, key, encoder.encode(plaintext));
  return { messageId, sequence, ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv), sentAt };
}

export async function decryptRoomMessage(roomId: string, secret: string, envelope: EncryptedMessage): Promise<string> {
  const key = await cachedRoomKey(roomId, secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv), additionalData: messageAad(roomId, envelope.messageId, envelope.sequence, envelope.sentAt) },
    key,
    base64UrlToBytes(envelope.ciphertext)
  );
  return decoder.decode(decrypted);
}
