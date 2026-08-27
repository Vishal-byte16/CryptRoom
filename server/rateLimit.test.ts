import { describe, expect, it } from "vitest";
import { BoundedRateLimiter } from "./rateLimit";
import { participantRateLimitKey } from "./roomRelay";

describe("bounded rate limiter", () => {
  it("rejects requests beyond the configured window limit and accepts requests after expiry", () => {
    const limiter = new BoundedRateLimiter(2, 1_000, 2);
    expect(limiter.consume("socket-a", 1)).toBe(true);
    expect(limiter.consume("socket-a", 2)).toBe(true);
    expect(limiter.consume("socket-a", 3)).toBe(false);
    expect(limiter.consume("socket-a", 1_100)).toBe(true);
  });

  it("bounds the number of retained client keys", () => {
    const limiter = new BoundedRateLimiter(1, 60_000, 2);
    limiter.consume("a", 1);
    limiter.consume("b", 2);
    limiter.consume("c", 3);
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });

  it("shares one budget across sockets for the same authenticated participant while isolating other participants", () => {
    const limiter = new BoundedRateLimiter(2, 1_000, 8);
    const participantA = participantRateLimitKey({ roomDbId: 41, participantId: 7 });
    const participantB = participantRateLimitKey({ roomDbId: 41, participantId: 8 });
    expect(limiter.consume(participantA, 1)).toBe(true); // Tab A
    expect(limiter.consume(participantA, 2)).toBe(true); // Tab B
    expect(limiter.consume(participantA, 3)).toBe(false); // Tab C shares budget
    expect(limiter.consume(participantB, 3)).toBe(true); // Independent participant
  });
});
