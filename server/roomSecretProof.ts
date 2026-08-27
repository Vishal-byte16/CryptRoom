import { createHmac, timingSafeEqual } from "node:crypto";

export function joinProofPayload(roomId: string, challengeId: string, challenge: string) {
  return `CryptRoom/v2/join/${roomId}/${challengeId}/${challenge}`;
}

export function createExpectedJoinProof(secretVerifier: string, roomId: string, challengeId: string, challenge: string) {
  return createHmac("sha256", Buffer.from(secretVerifier, "base64url"))
    .update(joinProofPayload(roomId, challengeId, challenge), "utf8")
    .digest("base64url");
}

export function matchesJoinProof(expectedProof: string, candidateProof: string) {
  const expected = Buffer.from(expectedProof, "base64url");
  const candidate = Buffer.from(candidateProof, "base64url");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
