/**
 * In-memory counting semaphore for saturation-aware webhook acceptance. The
 * receiver acquires a slot per in-flight request; when the semaphore is full,
 * `tryAcquire` returns false and the caller responds with `503` so the
 * upstream provider backs off. Releasing is synchronous and idempotent
 * within the lifetime of a single permit.
 *
 * No queueing on purpose: when the receiver falls behind, we want the
 * upstream to either retry later (Helius does, with exponential backoff) or
 * load-balance to a peer instance — we do NOT want to internally buffer
 * unbounded requests and slow-block the event loop.
 */
export class Semaphore {
  private available: number;
  private readonly max: number;

  constructor(max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`Semaphore: max must be a positive integer; got ${max}`);
    }
    this.max = Math.trunc(max);
    this.available = this.max;
  }

  /**
   * Attempt to acquire a permit. Returns a release function on success, or
   * `null` when saturated. The release function is idempotent — calling it
   * a second time is a no-op rather than over-releasing.
   */
  tryAcquire(): null | (() => void) {
    if (this.available <= 0) return null;
    this.available -= 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available += 1;
      if (this.available > this.max) {
        // Defensive: this should be unreachable. Cap at max instead of
        // silently corrupting the counter.
        this.available = this.max;
      }
    };
  }

  /** Number of currently-held permits. */
  inFlight(): number {
    return this.max - this.available;
  }

  /** Maximum capacity. */
  capacity(): number {
    return this.max;
  }
}
