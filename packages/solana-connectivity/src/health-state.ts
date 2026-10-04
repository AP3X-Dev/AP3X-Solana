/**
 * HealthState — per-endpoint health state machine.
 *
 * Per spec Section 3.2 endpoints transition between three states based on
 * consecutive error / success streaks:
 *
 *   - `healthy`    — default, endpoint participates in round-robin reads.
 *   - `degraded`   — 5 consecutive errors. Endpoint is still eligible but
 *                     will be deprioritised (round-robin skips degraded
 *                     endpoints when any healthy peer exists; `pinForWrite`
 *                     still considers it if no healthy peer exists).
 *   - `unhealthy`  — 10 consecutive errors. Endpoint is removed from
 *                     selection, except for one probe call once a cooldown
 *                     has passed ({@link takeProbe}): 5 s, doubling after
 *                     each failed probe up to 60 s. A successful probe resets
 *                     it. Without probes nothing could ever succeed on it, and
 *                     a single-endpoint pool would stay down for good.
 *
 * A single success — regardless of current state — snaps the endpoint back to
 * `healthy` and resets the error counter. This is deliberately aggressive:
 * an RPC node that was flapping and has now responded correctly is usable
 * again, and forcing it through a slow warm-up adds latency without making
 * the system safer (subsequent failures would re-degrade it within 5 calls).
 */

/** The three reachable health states for an endpoint. */
export type HealthStateName = 'healthy' | 'degraded' | 'unhealthy';

export class HealthState {
  /** Consecutive errors that trigger the `healthy → degraded` transition. */
  static readonly DEGRADE_THRESHOLD = 5;

  /** Consecutive errors that trigger the `* → unhealthy` transition. */
  static readonly UNHEALTHY_THRESHOLD = 10;

  /** First wait before probing an unhealthy endpoint; doubles per failed probe. */
  static readonly PROBE_COOLDOWN_MS = 5_000;
  static readonly MAX_PROBE_COOLDOWN_MS = 60_000;

  #consecutiveErrors = 0;
  #state: HealthStateName = 'healthy';
  #cooldownMs = HealthState.PROBE_COOLDOWN_MS;
  #probeAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Current state. */
  state(): HealthStateName {
    return this.#state;
  }

  /**
   * Record a successful call. Always resets the error counter and snaps the
   * endpoint back to `healthy`. Returns the (post-transition) state.
   */
  recordSuccess(): HealthStateName {
    this.#consecutiveErrors = 0;
    this.#state = 'healthy';
    this.#cooldownMs = HealthState.PROBE_COOLDOWN_MS;
    return this.#state;
  }

  /**
   * Record a failed call. Increments the error counter and promotes the
   * state to `degraded` or `unhealthy` if the respective threshold is
   * crossed. Returns the post-transition state.
   *
   * Thresholds are checked in descending order so that the UNHEALTHY
   * threshold (10) is applied correctly even when the endpoint was already
   * in `degraded` — transition from `degraded → unhealthy` happens when the
   * running total of consecutive errors reaches 10, NOT after another 5 from
   * `degraded`. (The spec says "5 consecutive errors → degraded, 10 →
   * unhealthy" — the 10 is counted from the last success, not from the last
   * transition.)
   */
  recordError(): HealthStateName {
    this.#consecutiveErrors += 1;
    if (this.#consecutiveErrors >= HealthState.UNHEALTHY_THRESHOLD) {
      // Entering unhealthy waits the base cooldown; a failed probe doubles it.
      if (this.#state === 'unhealthy') this.#cooldownMs = Math.min(this.#cooldownMs * 2, HealthState.MAX_PROBE_COOLDOWN_MS);
      this.#probeAt = this.now() + this.#cooldownMs;
      this.#state = 'unhealthy';
    } else if (this.#consecutiveErrors >= HealthState.DEGRADE_THRESHOLD) {
      this.#state = 'degraded';
    }
    return this.#state;
  }

  /**
   * Record a rate limit (HTTP 429). The node is up and asking us to slow down:
   * a streak can degrade it (peers are preferred) but never makes it unhealthy,
   * which would turn throttling into a full outage of a single-endpoint pool
   * for up to a minute (measured: a burst of reads did exactly that).
   */
  recordRateLimit(): HealthStateName {
    this.#consecutiveErrors += 1;
    if (this.#state === 'healthy' && this.#consecutiveErrors >= HealthState.DEGRADE_THRESHOLD) this.#state = 'degraded';
    return this.#state;
  }

  /**
   * True when an unhealthy endpoint is due one probe call. Claims it: the
   * next probe waits another cooldown, so concurrent callers send one probe,
   * not a burst.
   */
  takeProbe(): boolean {
    if (this.#state !== 'unhealthy' || this.now() < this.#probeAt) return false;
    this.#probeAt = this.now() + this.#cooldownMs;
    return true;
  }

  /**
   * Current consecutive error count. Exposed for observability tests —
   * production callers should use {@link state} instead.
   */
  consecutiveErrors(): number {
    return this.#consecutiveErrors;
  }
}
