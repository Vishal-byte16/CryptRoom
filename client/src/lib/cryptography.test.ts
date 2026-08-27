import { describe, expect, it } from "vitest";
import { isValidEncryptedMessageEnvelope } from "./cryptography";

describe("client encrypted envelope validation", () => {
  const now = 1_700_000_000_000;
  const valid = { messageId: "a".repeat(22), sequence: 3, ciphertext: "b".repeat(24), iv: "c".repeat(16), sentAt: now };

  it("accepts a structurally valid recent encrypted envelope", () => {
    expect(isValidEncryptedMessageEnvelope(valid, now)).toBe(true);
  });

  it("rejects malformed, stale, unsafe, and oversized envelopes before decryption", () => {
    expect(isValidEncryptedMessageEnvelope({ ...valid, messageId: "bad" }, now)).toBe(false);
    expect(isValidEncryptedMessageEnvelope({ ...valid, sequence: 0 }, now)).toBe(false);
    expect(isValidEncryptedMessageEnvelope({ ...valid, sentAt: now + 360_001 }, now)).toBe(false);
    expect(isValidEncryptedMessageEnvelope({ ...valid, iv: "short" }, now)).toBe(false);
    expect(isValidEncryptedMessageEnvelope({ ...valid, ciphertext: "x".repeat(8_501) }, now)).toBe(false);
  });
});
