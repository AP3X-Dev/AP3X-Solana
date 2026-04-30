import type { WebhookEvent } from '../types.js';
import type { Outbox, OutboxRow, PendingOptions } from './store.js';

// ---------------------------------------------------------------------------
// pg surface — typed minimally so we don't depend on @types/pg
// ---------------------------------------------------------------------------

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!SAFE_IDENT_RE.test(name)) {
    throw new Error(`PostgresOutbox: identifier is not safe: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PostgresOutboxConfig {
  /** Postgres connection string, e.g. `postgres://user:pw@host:5432/db`. */
  connectionString: string;
  /**
   * Optional Postgres schema namespace. When set, the table is qualified
   * `<schema>.webhook_events` and the schema is created if absent. Useful
   * for isolating webhook outbox storage from the consumer's own schema.
   */
  schema?: string;
  /** `pg.Pool` `max` — concurrent connections. Defaults to pg's default. */
  poolSize?: number;
  /** Passed through to `pg.Pool` `ssl`. Use `true` or a `ConnectionOptions` object. */
  ssl?: boolean | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PostgresOutbox
// ---------------------------------------------------------------------------

/**
 * Postgres-backed {@link Outbox}. Production-grade alternative to
 * {@link SqliteOutbox} for higher concurrency, multi-process receiver
 * deployments, or any setup where SQLite's single-writer model is the
 * bottleneck.
 *
 * Schema (idempotent — created via `init()`):
 *   webhook_events (
 *     source       TEXT      NOT NULL,
 *     id           TEXT      NOT NULL,
 *     received_at  BIGINT    NOT NULL,
 *     raw_payload  BYTEA     NOT NULL,
 *     metadata     JSONB,
 *     processed_at BIGINT,
 *     error        TEXT,
 *     attempts     INT NOT NULL DEFAULT 0,
 *     PRIMARY KEY (source, id)
 *   )
 *   INDEX idx_webhook_events_pending
 *     ON webhook_events (received_at) WHERE processed_at IS NULL
 *
 * Identical semantics to SqliteOutbox — see the cross-backend parity suite
 * for the contract that both backends share.
 */
export class PostgresOutbox implements Outbox {
  private pool: PgPool | null = null;
  private readonly table: string;
  private readonly config: PostgresOutboxConfig;

  constructor(config: PostgresOutboxConfig) {
    this.config = config;
    this.table = config.schema
      ? `${quoteIdent(config.schema)}.webhook_events`
      : 'webhook_events';
  }

  async init(): Promise<void> {
    if (this.pool) return;

    // Dynamic import keeps pg an optional peer — packages that never
    // instantiate PostgresOutbox don't need it installed.
    // @ts-expect-error — pg is an optional peer dependency
    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Pool = pg.Pool ?? (pg.default as any)?.Pool ?? pg;

    const poolConfig: Record<string, unknown> = { connectionString: this.config.connectionString };
    if (this.config.poolSize !== undefined) poolConfig['max'] = this.config.poolSize;
    if (this.config.ssl       !== undefined) poolConfig['ssl'] = this.config.ssl;

    const pool = new Pool(poolConfig) as PgPool;

    try {
      if (this.config.schema) {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.config.schema)}`);
      }
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          source       TEXT      NOT NULL,
          id           TEXT      NOT NULL,
          received_at  BIGINT    NOT NULL,
          raw_payload  BYTEA     NOT NULL,
          metadata     JSONB,
          processed_at BIGINT,
          error        TEXT,
          attempts     INT       NOT NULL DEFAULT 0,
          PRIMARY KEY (source, id)
        )
      `);
      // Partial index on the pending subset keeps the drainer's pending scan
      // efficient even when the table grows large with processed history.
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_webhook_events_pending
         ON ${this.table} (received_at) WHERE processed_at IS NULL`,
      );
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }

    this.pool = pool;
  }

  async insert(event: WebhookEvent): Promise<boolean> {
    const pool = this.requirePool();
    const metadata = event.metadata ? JSON.stringify(event.metadata) : null;
    const result = await pool.query(
      `INSERT INTO ${this.table}
        (source, id, received_at, raw_payload, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, id) DO NOTHING`,
      [event.source, event.id, event.receivedAt, Buffer.from(event.rawPayload), metadata],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async pending(opts: PendingOptions): Promise<OutboxRow[]> {
    const pool = this.requirePool();
    const limit = opts.limit;
    const maxAttempts = opts.maxAttempts;
    const retryDelayMs = opts.retryDelayMs ?? 0;

    let rows: Record<string, unknown>[];
    if (maxAttempts === undefined || maxAttempts === Infinity) {
      const result = await pool.query(
        `SELECT source, id, received_at, raw_payload, metadata, processed_at, error, attempts
         FROM ${this.table}
         WHERE processed_at IS NULL
         ORDER BY received_at ASC
         LIMIT $1`,
        [limit],
      );
      rows = result.rows;
    } else {
      const cutoff = Date.now() - retryDelayMs;
      const result = await pool.query(
        `SELECT source, id, received_at, raw_payload, metadata, processed_at, error, attempts
         FROM ${this.table}
         WHERE processed_at IS NULL
           AND attempts < $1
           AND (attempts = 0 OR received_at <= $2)
         ORDER BY received_at ASC
         LIMIT $3`,
        [maxAttempts, cutoff, limit],
      );
      rows = result.rows;
    }

    return rows.map((r) => this.deserialize(r));
  }

  async markProcessed(source: string, id: string, processedAt: number): Promise<void> {
    const pool = this.requirePool();
    const result = await pool.query(
      `UPDATE ${this.table}
       SET processed_at = $1, error = NULL
       WHERE source = $2 AND id = $3`,
      [processedAt, source, id],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`PostgresOutbox.markProcessed: no row for (${source}, ${id})`);
    }
  }

  async markFailed(source: string, id: string, error: string, attempts: number): Promise<void> {
    const pool = this.requirePool();
    const result = await pool.query(
      `UPDATE ${this.table}
       SET error = $1, attempts = $2
       WHERE source = $3 AND id = $4`,
      [error, attempts, source, id],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`PostgresOutbox.markFailed: no row for (${source}, ${id})`);
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    const p = this.pool;
    this.pool = null;
    await p.end();
  }

  /** Cheap pending-count probe; useful for healthz and metrics. */
  async countPending(): Promise<number> {
    const pool = this.requirePool();
    const result = await pool.query(
      `SELECT COUNT(*)::INT AS n FROM ${this.table} WHERE processed_at IS NULL`,
    );
    const row = result.rows[0];
    return row ? Number(row['n']) : 0;
  }

  private requirePool(): PgPool {
    if (!this.pool) {
      throw new Error('PostgresOutbox not initialized. Call init() first.');
    }
    return this.pool;
  }

  private deserialize(row: Record<string, unknown>): OutboxRow {
    const source = row['source'] as string;
    const id = row['id'] as string;
    const receivedAt = Number(row['received_at']);
    const rawPayloadBlob = row['raw_payload'];
    const rawPayload =
      rawPayloadBlob instanceof Uint8Array
        ? new Uint8Array(rawPayloadBlob)
        : Buffer.isBuffer(rawPayloadBlob)
        ? new Uint8Array(rawPayloadBlob)
        : new Uint8Array();
    const metadataRaw = row['metadata'];
    const metadata =
      metadataRaw == null
        ? undefined
        : (typeof metadataRaw === 'string'
            ? (JSON.parse(metadataRaw) as Record<string, string>)
            : (metadataRaw as Record<string, string>));
    const processedAtRaw = row['processed_at'];
    const processedAt = processedAtRaw == null ? null : Number(processedAtRaw);
    const error = (row['error'] as string | null) ?? null;
    const attempts = Number(row['attempts']);

    const out: OutboxRow = {
      source,
      id,
      receivedAt,
      rawPayload,
      processedAt,
      error,
      attempts,
    };
    if (metadata) out.metadata = metadata;
    return out;
  }
}
