import type { WebhookEvent } from '../types.js';

/**
 * One row in the outbox. Adds drainer tracking fields on top of the raw
 * {@link WebhookEvent} the receiver persisted.
 */
export interface OutboxRow extends WebhookEvent {
  /** Timestamp the drainer marked this row as processed. `null` = pending. */
  processedAt: number | null;
  /** Last error seen by the drainer when processing this row. */
  error: string | null;
  /** Number of drainer attempts made so far. Increments on each markFailed. */
  attempts: number;
}

/**
 * Pending fetch options. The drainer tunes these per cycle.
 */
export interface PendingOptions {
  /** Max rows to return. */
  limit: number;
  /**
   * Skip rows whose attempt count is at or above this value. Used to avoid
   * starvation when a poison-pill row is failing repeatedly. Default `Infinity`
   * (no skipping).
   */
  maxAttempts?: number;
  /**
   * Only return rows with attempts > 0 (i.e. previously failed) when their
   * receivedAt is older than `now - retryDelayMs`. Lets the drainer apply
   * exponential backoff at the application layer. Default 0 (no delay).
   */
  retryDelayMs?: number;
}

/**
 * Outbox storage backend. The receiver inserts; the drainer reads pending
 * and marks rows as processed or failed. Backends include SQLite (dev) and
 * Postgres (production).
 *
 * Idempotency: `insert()` returns `false` for re-deliveries (composite
 * `(source, id)` already exists). The receiver responds 200 OK to such cases
 * — the upstream provider should not retry, but if it does, the second
 * insert is a no-op rather than a duplicate signal emission.
 *
 * Order: `pending()` returns rows in ascending `receivedAt` order so the
 * drainer processes events FIFO across retries.
 */
export interface Outbox {
  /**
   * Idempotent migration. Creates tables/indices if absent. Safe to call
   * multiple times. Backends may also apply pragmas / connection setup here.
   */
  init(): Promise<void>;

  /**
   * Persist an event for later processing.
   * @returns `true` if a new row was created, `false` if a row with the same
   *          `(source, id)` already existed (duplicate delivery).
   */
  insert(event: WebhookEvent): Promise<boolean>;

  /**
   * Fetch up to `opts.limit` pending rows in receivedAt order. Empty array
   * when nothing is pending.
   */
  pending(opts: PendingOptions): Promise<OutboxRow[]>;

  /**
   * Mark a row as successfully processed.
   * @throws when `(source, id)` does not exist.
   */
  markProcessed(source: string, id: string, processedAt: number): Promise<void>;

  /**
   * Mark a row as failed with the given error message and incremented
   * attempts count. The drainer is responsible for the attempts arithmetic.
   * @throws when `(source, id)` does not exist.
   */
  markFailed(source: string, id: string, error: string, attempts: number): Promise<void>;

  /** Close any underlying connections. Idempotent. */
  close(): Promise<void>;
}
