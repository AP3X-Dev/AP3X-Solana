export type SubmitPayload =
  | { kind: 'tx'; signedTx: Uint8Array }
  // A bundle's tip is a transfer instruction inside one of its transactions,
  // added by the executor before signing — not a separate payload field.
  | { kind: 'bundle'; signedTxs: Uint8Array[] };

export interface SubmissionAck {
  kind: 'tx' | 'bundle';
  signature?: string;     // for tx submits
  bundleId?: string;      // for bundle submits
  submitterUsed: string;
}

export interface SubmitterHealth {
  state: 'healthy' | 'degraded' | 'unhealthy';
  reason?: string;
  lastOkAt?: number;
}

export interface Submitter {
  readonly name: string;
  readonly kind: 'rpc' | 'jito-http' | 'jito-grpc' | 'custom';
  submit(payload: SubmitPayload): Promise<SubmissionAck>;
  health(): SubmitterHealth;
}

/**
 * Tracks a submitter's health from its own submit outcomes: a failure marks
 * it `unhealthy` for `cooldownMs`, after which it reports `degraded` (usable
 * again, so it can recover) until the next success.
 */
export class HealthTracker {
  #lastOkAt = 0;
  #failedAt: number | undefined;
  #reason: string | undefined;

  constructor(
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  ok(): void {
    this.#lastOkAt = this.now();
    this.#failedAt = undefined;
    this.#reason = undefined;
  }

  fail(err: unknown): void {
    this.#failedAt = this.now();
    this.#reason = err instanceof Error ? err.message : String(err);
  }

  health(): SubmitterHealth {
    if (this.#failedAt === undefined) return { state: 'healthy', lastOkAt: this.#lastOkAt };
    const cooling = this.now() - this.#failedAt < this.cooldownMs;
    return {
      state: cooling ? 'unhealthy' : 'degraded',
      lastOkAt: this.#lastOkAt,
      ...(this.#reason !== undefined ? { reason: this.#reason } : {}),
    };
  }

  /** Run `fn`, recording its outcome. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.ok();
      return out;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }
}
