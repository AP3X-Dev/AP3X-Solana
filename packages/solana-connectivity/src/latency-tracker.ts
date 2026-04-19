/**
 * LatencyTracker — exponentially weighted moving average (EWMA) over the last
 * N call latencies, N = 50.
 *
 * Per spec Section 3.2 each `RpcPool` endpoint owns a tracker, and the pool's
 * `pinForWrite()` selects the endpoint with the lowest EWMA. The EWMA is
 * recorded once per `RpcPool.call` (successful OR failed) so we can compare
 * endpoints on a like-for-like basis — failed calls still tell us something
 * about the endpoint's responsiveness.
 *
 * Why EWMA over a simple rolling mean:
 *
 *   - O(1) update + O(1) state (a single number), vs. O(N) state for a ring
 *     buffer. The RPC pool runs on the hot path, so constant-time matters.
 *   - Recent samples weigh more than older ones — an endpoint that was fast
 *     but just went slow is penalised before we've filled a whole window.
 *   - The classical smoothing factor α = 2 / (N + 1) matches the "last N
 *     samples" intuition: a true simple MA over 50 samples has the same
 *     centre-of-mass as an EWMA with α = 2/51 ≈ 0.0392.
 *
 * Why `ewma()` returns Infinity on an empty tracker:
 *
 *   - `pinForWrite()` sorts endpoints by `ewma()` ascending and picks the
 *     smallest healthy one. An unseeded endpoint has no data, so it must not
 *     be selected over a seeded one with, say, 500 ms latency. Returning
 *     Infinity puts unseeded trackers at the end of the sort — they are only
 *     chosen if every seeded alternative is unhealthy. If callers want
 *     different semantics they can branch on `samples() === 0`.
 */
export class LatencyTracker {
  /** Rolling window size. The EWMA smoothing factor is derived from this. */
  static readonly WINDOW = 50;

  /**
   * EWMA smoothing factor, 2 / (N + 1). For N = 50 this is ~0.0392 —
   * classical exponential smoothing constant that makes the EWMA's centre of
   * mass coincide with a simple moving average over the last N samples.
   */
  static readonly ALPHA = 2 / (LatencyTracker.WINDOW + 1);

  #ewma: number | null = null;
  #samples = 0;

  /**
   * Record a new latency sample. First sample seeds the EWMA directly; every
   * subsequent sample blends in with weight α.
   */
  record(latencyMs: number): void {
    if (this.#ewma === null) {
      this.#ewma = latencyMs;
    } else {
      this.#ewma =
        LatencyTracker.ALPHA * latencyMs +
        (1 - LatencyTracker.ALPHA) * this.#ewma;
    }
    // Sample count is capped at WINDOW — once we have a "full window" of
    // observations, any caller that wants to know whether the tracker is
    // primed can check `samples() >= WINDOW`. The EWMA itself keeps updating
    // past the cap; this counter is purely informational.
    this.#samples = Math.min(this.#samples + 1, LatencyTracker.WINDOW);
  }

  /**
   * Current EWMA estimate. Returns `Infinity` when no samples have been
   * recorded — see class header for the rationale.
   */
  ewma(): number {
    return this.#ewma ?? Infinity;
  }

  /** Number of samples observed, capped at {@link LatencyTracker.WINDOW}. */
  samples(): number {
    return this.#samples;
  }
}
