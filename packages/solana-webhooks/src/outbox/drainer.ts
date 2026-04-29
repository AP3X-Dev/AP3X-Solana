import type {
  TypedSolanaEvent,
  WebhookDriver,
  RawWebhookEvent,
  MetricsEmitter,
} from '../types.js';
import { noopMetrics } from '../types.js';
import type { Outbox, OutboxRow } from './store.js';

/** Per-typed-event callback the drainer invokes for every successful normalization. */
export type DrainerEmit = (event: TypedSolanaEvent, ctx: DrainerEmitContext) => Promise<void>;

export interface DrainerEmitContext {
  /** Outbox source (driver.source) — useful for fan-out by transport. */
  source: string;
  /** Outbox row id (driver-supplied per-tx id, e.g. helius:<signature>). */
  rowId: string;
  /** When the receiver originally accepted this event. */
  receivedAt: number;
}

export interface DrainerOptions {
  outbox: Outbox;
  /** Source → driver. Drainer rejects rows with no matching driver as "no driver registered". */
  drivers: Readonly<Record<string, WebhookDriver>>;
  /** Where each normalized event is emitted. */
  emit: DrainerEmit;
  /** Poll interval when the outbox is empty. Default 250ms. */
  pollIntervalMs?: number;
  /** Max rows fetched per drain cycle. Default 100. */
  batchSize?: number;
  /** Max attempts before a row is parked. Default 5. */
  maxAttempts?: number;
  /** Wait this long before re-attempting a previously-failed row. Default 1000ms. */
  retryDelayMs?: number;
  /** Optional metrics sink. */
  metrics?: MetricsEmitter;
  /** Hook for controlling the loop in tests — defaults to setTimeout. */
  setTimer?: (cb: () => void, ms: number) => { unref?: () => void };
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Reads pending outbox rows, normalizes each via the row's driver, and emits
 * every produced {@link TypedSolanaEvent} through the supplied callback. On
 * success: marks the row processed. On normalize / emit failure: marks
 * failed with incremented attempts.
 *
 * The drainer is push-on-pull: it polls the outbox on `pollIntervalMs` and
 * processes whatever it finds. No external trigger is needed — once
 * `start()` resolves, the loop runs until `stop()`.
 *
 * Failure modes:
 *  - **No driver for a row's source** → mark failed permanently (`attempts =
 *    Infinity`-equivalent: the maxAttempts cap excludes it from future
 *    `pending()` queries). A row with an orphaned source is operator-action
 *    territory.
 *  - **`driver.normalizeEvent` throws** → mark failed with the error's
 *    message. The row stays pending until `attempts >= maxAttempts`.
 *  - **Stored payload is not valid JSON** → mark failed permanently. A
 *    corrupt row has no recovery path through the same driver.
 *  - **`emit` throws** → mark failed; same retry path as normalize errors.
 *    The application's emit shim is the natural place to apply a dead-
 *    letter queue.
 */
export class Drainer {
  private readonly opts: Required<Omit<DrainerOptions, 'metrics' | 'setTimer'>> & {
    metrics: MetricsEmitter;
    setTimer: NonNullable<DrainerOptions['setTimer']>;
  };
  private running = false;
  private stopRequested = false;
  private waiter: Promise<void> | null = null;
  private resolveWaiter: (() => void) | null = null;
  private timer: { unref?: () => void } | null = null;

  constructor(opts: DrainerOptions) {
    this.opts = {
      outbox: opts.outbox,
      drivers: opts.drivers,
      emit: opts.emit,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_MS,
      batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      retryDelayMs: opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      metrics: opts.metrics ?? noopMetrics,
      setTimer: opts.setTimer ?? ((cb, ms) => {
        const t = setTimeout(cb, ms);
        // Don't keep the event loop alive solely for the drainer.
        t.unref?.();
        return { unref: () => t.unref?.() };
      }),
    };
  }

  /**
   * Begin the poll loop. Resolves immediately; the loop runs in the
   * background until `stop()`. Calling start twice is a no-op.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.scheduleNext(0);
  }

  /**
   * Request the drainer stop. Resolves when the in-flight cycle (if any)
   * completes. Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopRequested = true;
    if (this.waiter) await this.waiter;
    this.running = false;
  }

  /** Manually run one drain cycle. Useful for tests; production uses the loop. */
  async drainOnce(): Promise<{ processed: number; failed: number }> {
    return this.cycle();
  }

  // ----- Loop control --------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.stopRequested) return;
    this.timer = this.opts.setTimer(() => { void this.runCycle(); }, delayMs);
  }

  private async runCycle(): Promise<void> {
    if (this.stopRequested) return;

    // Track an in-flight promise so stop() can await it.
    this.waiter = new Promise<void>((resolve) => { this.resolveWaiter = resolve; });

    let result: { processed: number; failed: number };
    try {
      result = await this.cycle();
    } catch (err) {
      this.opts.metrics.count('ap3x.webhooks.drainer.cycle_error');
      result = { processed: 0, failed: 0 };
      // eslint-disable-next-line no-console
      console.error('[ap3x/solana-webhooks] drainer cycle threw:', err);
    } finally {
      this.resolveWaiter?.();
      this.resolveWaiter = null;
      this.waiter = null;
    }

    if (this.stopRequested) return;

    // Aggressive next-cycle scheduling when we did work; back off when idle.
    const nextDelay = result.processed > 0 || result.failed > 0 ? 0 : this.opts.pollIntervalMs;
    this.scheduleNext(nextDelay);
  }

  // ----- One drain cycle -----------------------------------------------

  private async cycle(): Promise<{ processed: number; failed: number }> {
    const rows = await this.opts.outbox.pending({
      limit: this.opts.batchSize,
      maxAttempts: this.opts.maxAttempts,
      retryDelayMs: this.opts.retryDelayMs,
    });

    if (rows.length === 0) return { processed: 0, failed: 0 };

    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      if (this.stopRequested) break;
      const ok = await this.processOne(row);
      if (ok) processed += 1;
      else failed += 1;
    }
    return { processed, failed };
  }

  private async processOne(row: OutboxRow): Promise<boolean> {
    const driver = this.opts.drivers[row.source];
    if (!driver) {
      await this.opts.outbox.markFailed(
        row.source,
        row.id,
        'no driver registered',
        this.opts.maxAttempts, // park permanently — no driver = no recovery
      );
      this.opts.metrics.count('ap3x.webhooks.drainer.no_driver', 1, { source: row.source });
      return false;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8').decode(row.rawPayload));
    } catch (err) {
      await this.opts.outbox.markFailed(
        row.source,
        row.id,
        `payload parse: ${errMessage(err)}`,
        this.opts.maxAttempts, // corrupt JSON has no retry path
      );
      this.opts.metrics.count('ap3x.webhooks.drainer.parse_error', 1, { source: row.source });
      return false;
    }

    const raw: RawWebhookEvent = { id: row.id, source: row.source, payload };

    let events: TypedSolanaEvent[];
    try {
      events = driver.normalizeEvent(raw);
    } catch (err) {
      await this.opts.outbox.markFailed(
        row.source,
        row.id,
        `normalize: ${errMessage(err)}`,
        row.attempts + 1,
      );
      this.opts.metrics.count('ap3x.webhooks.drainer.normalize_error', 1, { source: row.source });
      return false;
    }

    try {
      for (const event of events) {
        await this.opts.emit(event, {
          source: row.source,
          rowId: row.id,
          receivedAt: row.receivedAt,
        });
      }
    } catch (err) {
      await this.opts.outbox.markFailed(
        row.source,
        row.id,
        `emit: ${errMessage(err)}`,
        row.attempts + 1,
      );
      this.opts.metrics.count('ap3x.webhooks.drainer.emit_error', 1, { source: row.source });
      return false;
    }

    await this.opts.outbox.markProcessed(row.source, row.id, Date.now());
    this.opts.metrics.count('ap3x.webhooks.drainer.processed', 1, { source: row.source });
    this.opts.metrics.observe('ap3x.webhooks.drainer.events_per_row', events.length, { source: row.source });
    return true;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
