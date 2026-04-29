import type { WebhookEvent } from '../types.js';
import type { Outbox, OutboxRow, PendingOptions } from './store.js';

// ---------------------------------------------------------------------------
// better-sqlite3 surface — typed minimally so we don't depend on @types/better-sqlite3
// ---------------------------------------------------------------------------

interface BSqlite3Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

interface BSqlite3Database {
  prepare(sql: string): BSqlite3Statement;
  exec(sql: string): void;
  pragma(s: string, opts?: { simple?: boolean }): unknown;
  close(): void;
}

type BSqlite3Constructor = new (path: string) => BSqlite3Database;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Pragmas applied at connection open. Defaults are tuned for sustained
 * write pressure under multi-process contention. Override individual
 * keys; defaults still apply for the rest.
 */
export type SqlitePragmas = Record<string, string | number>;

const DEFAULT_PRAGMAS: SqlitePragmas = {
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  busy_timeout: 30_000,
  cache_size: -65_536, // 64 MiB
  temp_store: 'MEMORY',
};

const PRAGMA_VALUE_RE = /^[A-Za-z0-9_-]+$/;

function formatPragmaValue(key: string, val: string | number): string {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error(`SqliteOutbox: pragma "${key}" value is not a finite number: ${val}`);
    }
    return String(Math.trunc(val));
  }
  if (!PRAGMA_VALUE_RE.test(val)) {
    throw new Error(`SqliteOutbox: pragma "${key}" value is not a safe identifier: ${JSON.stringify(val)}`);
  }
  return val;
}

export interface SqliteOutboxConfig {
  /** Path to the SQLite file. Use `":memory:"` for in-process testing. */
  path: string;
  /** Optional pragma overrides; merged onto safer defaults. */
  pragmas?: SqlitePragmas;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Schema:
 *
 *   webhook_events (
 *     source         TEXT    NOT NULL,
 *     id             TEXT    NOT NULL,
 *     received_at    INTEGER NOT NULL,
 *     raw_payload    BLOB    NOT NULL,
 *     metadata       TEXT,                -- JSON-serialized Record<string,string> or NULL
 *     processed_at   INTEGER,             -- NULL = pending
 *     error          TEXT,                -- NULL when never failed
 *     attempts       INTEGER NOT NULL DEFAULT 0,
 *     PRIMARY KEY (source, id)
 *   )
 *
 *   INDEX idx_webhook_events_pending ON webhook_events (received_at) WHERE processed_at IS NULL
 *
 * Idempotency on `(source, id)` is the primary key — `INSERT ... ON CONFLICT DO NOTHING`
 * is naturally idempotent. The partial index keeps the drainer's pending
 * scan efficient even when the table grows large with processed history.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS webhook_events (
    source       TEXT    NOT NULL,
    id           TEXT    NOT NULL,
    received_at  INTEGER NOT NULL,
    raw_payload  BLOB    NOT NULL,
    metadata     TEXT,
    processed_at INTEGER,
    error        TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, id)
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_events_pending
    ON webhook_events (received_at)
    WHERE processed_at IS NULL;
`;

// ---------------------------------------------------------------------------
// SqliteOutbox
// ---------------------------------------------------------------------------

interface PreparedStatements {
  insert: BSqlite3Statement;
  pending: BSqlite3Statement;
  pendingWithMaxAttempts: BSqlite3Statement;
  markProcessed: BSqlite3Statement;
  markFailed: BSqlite3Statement;
  countPending: BSqlite3Statement;
}

/**
 * SQLite-backed {@link Outbox}. Suitable for development, single-instance
 * production, and any scenario where the receiver process is the only
 * writer. For multi-process or higher-volume deployments, use a Postgres
 * outbox instead.
 *
 * Loads `better-sqlite3` via dynamic import; the dep is declared as an
 * optional peer in package.json. Consumers who use the SQLite outbox install
 * it; consumers who only use Postgres do not.
 */
export class SqliteOutbox implements Outbox {
  private db: BSqlite3Database | null = null;
  private statements: PreparedStatements | null = null;
  private readonly config: SqliteOutboxConfig;

  constructor(config: SqliteOutboxConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (this.db) return;

    let DB: BSqlite3Constructor;
    try {
      // Dynamic import keeps better-sqlite3 truly optional — packages that
      // never instantiate SqliteOutbox don't need it installed.
      const mod = (await import('better-sqlite3' as string)) as
        | { default: BSqlite3Constructor }
        | BSqlite3Constructor;
      DB = (mod as { default?: BSqlite3Constructor }).default ?? (mod as BSqlite3Constructor);
    } catch {
      throw new Error('SqliteOutbox requires the `better-sqlite3` peer dependency. Run: pnpm add better-sqlite3');
    }

    const db = new DB(this.config.path);
    try {
      const pragmas: SqlitePragmas = { ...DEFAULT_PRAGMAS, ...(this.config.pragmas ?? {}) };
      // Apply pragmas in dependency order: journal_mode first (others depend on it).
      const ordered = ['journal_mode', 'synchronous', 'busy_timeout', 'cache_size', 'temp_store'];
      const seen = new Set<string>();
      for (const key of ordered) {
        const val = pragmas[key];
        if (val === undefined) continue;
        db.exec(`PRAGMA ${key} = ${formatPragmaValue(key, val)};`);
        seen.add(key);
      }
      for (const [key, val] of Object.entries(pragmas)) {
        if (seen.has(key) || val === undefined) continue;
        if (!PRAGMA_VALUE_RE.test(key)) {
          throw new Error(`SqliteOutbox: pragma name is not a safe identifier: ${JSON.stringify(key)}`);
        }
        db.exec(`PRAGMA ${key} = ${formatPragmaValue(key, val)};`);
      }

      db.exec(SCHEMA_SQL);
    } catch (err) {
      db.close();
      throw err;
    }

    this.db = db;
    this.statements = {
      insert: db.prepare(`
        INSERT INTO webhook_events (source, id, received_at, raw_payload, metadata)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (source, id) DO NOTHING
      `),
      pending: db.prepare(`
        SELECT source, id, received_at, raw_payload, metadata, processed_at, error, attempts
        FROM webhook_events
        WHERE processed_at IS NULL
        ORDER BY received_at ASC
        LIMIT ?
      `),
      pendingWithMaxAttempts: db.prepare(`
        SELECT source, id, received_at, raw_payload, metadata, processed_at, error, attempts
        FROM webhook_events
        WHERE processed_at IS NULL AND attempts < ?
          AND (attempts = 0 OR received_at <= ?)
        ORDER BY received_at ASC
        LIMIT ?
      `),
      markProcessed: db.prepare(`
        UPDATE webhook_events
        SET processed_at = ?, error = NULL
        WHERE source = ? AND id = ?
      `),
      markFailed: db.prepare(`
        UPDATE webhook_events
        SET error = ?, attempts = ?
        WHERE source = ? AND id = ?
      `),
      countPending: db.prepare(`
        SELECT COUNT(*) AS n FROM webhook_events WHERE processed_at IS NULL
      `),
    };
  }

  async insert(event: WebhookEvent): Promise<boolean> {
    const stmts = this.requireStatements();
    const metadata = event.metadata ? JSON.stringify(event.metadata) : null;
    const result = stmts.insert.run(
      event.source,
      event.id,
      event.receivedAt,
      // better-sqlite3 accepts Buffer or Uint8Array for BLOB columns.
      Buffer.from(event.rawPayload),
      metadata,
    );
    return result.changes === 1;
  }

  async pending(opts: PendingOptions): Promise<OutboxRow[]> {
    const stmts = this.requireStatements();
    const limit = opts.limit;
    const maxAttempts = opts.maxAttempts;
    const retryDelayMs = opts.retryDelayMs ?? 0;

    let rows: unknown[];
    if (maxAttempts === undefined || maxAttempts === Infinity) {
      rows = stmts.pending.all(limit);
    } else {
      // Apply retry-delay gate alongside the maxAttempts cap.
      const cutoff = Date.now() - retryDelayMs;
      rows = stmts.pendingWithMaxAttempts.all(maxAttempts, cutoff, limit);
    }

    return rows.map((r) => this.deserialize(r as Record<string, unknown>));
  }

  async markProcessed(source: string, id: string, processedAt: number): Promise<void> {
    const stmts = this.requireStatements();
    const result = stmts.markProcessed.run(processedAt, source, id);
    if (result.changes === 0) {
      throw new Error(`SqliteOutbox.markProcessed: no row for (${source}, ${id})`);
    }
  }

  async markFailed(source: string, id: string, error: string, attempts: number): Promise<void> {
    const stmts = this.requireStatements();
    const result = stmts.markFailed.run(error, attempts, source, id);
    if (result.changes === 0) {
      throw new Error(`SqliteOutbox.markFailed: no row for (${source}, ${id})`);
    }
  }

  async close(): Promise<void> {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.statements = null;
  }

  /** Cheap pending-count probe; useful for healthz and metrics. */
  countPending(): number {
    const stmts = this.requireStatements();
    const r = stmts.countPending.get() as { n: number };
    return r.n;
  }

  private requireStatements(): PreparedStatements {
    if (!this.statements) {
      throw new Error('SqliteOutbox not initialized. Call init() first.');
    }
    return this.statements;
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
    const metadataJson = row['metadata'] as string | null;
    const metadata = metadataJson
      ? (JSON.parse(metadataJson) as Record<string, string>)
      : undefined;
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
