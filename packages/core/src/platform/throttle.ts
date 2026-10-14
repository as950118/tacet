/**
 * Counts failures per key (an IP, an email) in a sliding window and says when a key has had too many. Kept in this
 * process's memory: right for one API instance (ADR-0002); several instances would each allow the limit.
 */
export class FailureThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    readonly limit = 10,
    readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the busiest of these keys may try again, or 0 when none is over the limit. */
  retryAfter(keys: string[]): number {
    const now = this.now();
    let wait = 0;
    for (const key of keys) {
      const times = this.recent(key, now);
      if (times.length >= this.limit) wait = Math.max(wait, Math.ceil((times[0] + this.windowMs - now) / 1000));
    }
    return wait;
  }

  fail(keys: string[]): void {
    const now = this.now();
    for (const key of keys) this.failures.set(key, [...this.recent(key, now), now]);
    // Forget keys that went quiet, so a stream of distinct emails cannot grow the map without bound.
    if (this.failures.size > 10_000) for (const key of this.failures.keys()) if (!this.recent(key, now).length) this.failures.delete(key);
  }

  succeed(keys: string[]): void {
    for (const key of keys) this.failures.delete(key);
  }

  private recent(key: string, now: number): number[] {
    return (this.failures.get(key) ?? []).filter((t) => t > now - this.windowMs);
  }
}
