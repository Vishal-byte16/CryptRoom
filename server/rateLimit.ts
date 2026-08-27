type RateLimitEntry = {
  hits: number[];
  lastTouched: number;
};

/** A bounded, in-memory limiter suitable for a single-process deployment. */
export class BoundedRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxEntries: number
  ) {}

  consume(key: string, now = Date.now()): boolean {
    this.prune(now);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) this.removeOldest();
      entry = { hits: [], lastTouched: now };
      this.entries.set(key, entry);
    }

    entry.hits = entry.hits.filter(timestamp => now - timestamp < this.windowMs);
    entry.lastTouched = now;
    if (entry.hits.length >= this.limit) return false;
    entry.hits.push(now);
    return true;
  }

  size() {
    return this.entries.size;
  }

  private prune(now: number) {
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (now - entry.lastTouched >= this.windowMs) this.entries.delete(key);
    }
  }

  private removeOldest() {
    let oldestKey: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [key, entry] of Array.from(this.entries.entries())) {
      if (entry.lastTouched < oldestTimestamp) {
        oldestTimestamp = entry.lastTouched;
        oldestKey = key;
      }
    }
    if (oldestKey) this.entries.delete(oldestKey);
  }
}
