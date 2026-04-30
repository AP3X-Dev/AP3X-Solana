import type {
  PumpfunSignals,
  PumpfunSignalsVersions,
  Tier,
  ConvergenceState,
  MilestoneEvent,
  MilestoneKind,
  SafetyVerdict,
  SafetyLabel,
} from './types.js';

// ---------------------------------------------------------------------------
// better-sqlite3 surface — typed minimally so we don't depend on @types/better-sqlite3
// ---------------------------------------------------------------------------

interface BSqlite3Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BSqlite3Database {
  prepare(sql: string): BSqlite3Statement;
  exec(sql: string): void;
  pragma(s: string): unknown;
  close(): void;
}

type BSqlite3Constructor = new (path: string) => BSqlite3Database;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * Per-method signal versions. Bumped when the method's semantics change in
 * a way that would invalidate prior backtests. Hard-coded; never derived.
 */
export const SIGNAL_VERSIONS: PumpfunSignalsVersions = {
  walletTier: 'v1',
  convergenceState: 'v1',
  milestoneEvents: 'v1',
  safetyVerdict: 'v1',
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * One table — `solana_events` — holds every observation. Each row is a typed
 * event (`event_type`) with optional `mint` and `wallet` selectors plus a
 * JSON `payload` carrying type-specific data. Signals are derived on-demand
 * via WHERE clauses on `observed_at <= asOf`.
 *
 * Indexes:
 *   - by (mint, observed_at) for milestoneEvents + convergenceState lookups
 *   - by (wallet, observed_at) for walletTier
 *   - by (event_type, observed_at) for cross-cutting queries
 *
 * The whole-table replacement story (Parquet/DuckDB) is documented in the
 * package README; consumers code against the {@link PumpfunSignals}
 * interface, not the table layout below.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS solana_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    signature     TEXT,
    slot          INTEGER,
    observed_at   INTEGER NOT NULL,
    mint          TEXT,
    wallet        TEXT,
    event_type    TEXT NOT NULL,
    payload       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pf_events_mint_ts   ON solana_events (mint,       observed_at);
  CREATE INDEX IF NOT EXISTS idx_pf_events_wallet_ts ON solana_events (wallet,     observed_at);
  CREATE INDEX IF NOT EXISTS idx_pf_events_type_ts   ON solana_events (event_type, observed_at);
`;

const EVENT_TYPE = {
  buy:           'buy',
  milestone:     'milestone',
  walletTier:    'wallet-tier',
  safetyVerdict: 'safety-verdict',
} as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SqlitePumpfunSignalsConfig {
  /** Path to the SQLite file. Use `":memory:"` for tests. */
  path: string;
}

// ---------------------------------------------------------------------------
// Ingest payloads
// ---------------------------------------------------------------------------

export interface IngestBuyArgs {
  signature: string;
  slot: number;
  observedAt: Date;
  mint: string;
  wallet: string;
  /** Buyer's tier at the time of the buy, if known. Optional. */
  buyerTier?: Tier;
  /** SOL amount of the buy. Used for downstream weighting; opaque to this package. */
  amountSol?: number;
}

export interface IngestMilestoneArgs {
  mint: string;
  kind: MilestoneKind;
  observedAt: Date;
  signature?: string;
  slot?: number;
  data?: Record<string, unknown>;
}

export interface IngestWalletTierArgs {
  wallet: string;
  tier: Tier;
  observedAt: Date;
}

export interface IngestSafetyVerdictArgs {
  mint: string;
  observedAt: Date;
  verdict: SafetyLabel;
  reasons: string[];
  signals: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SqlitePumpfunSignals
// ---------------------------------------------------------------------------

interface PreparedStatements {
  insertEvent: BSqlite3Statement;
  walletTierLatest: BSqlite3Statement;
  convergenceWindow: BSqlite3Statement;
  milestonesRange: BSqlite3Statement;
  safetyLatest: BSqlite3Statement;
}

/**
 * sqlite-backed reference implementation of {@link PumpfunSignals}. Apply
 * `asOf` at the SQL `WHERE` clause so later-observed events cannot leak
 * into earlier-asOf queries. The whole storage layer is replaced in a
 * later release; the {@link PumpfunSignals} interface is what consumers
 * bind to.
 */
export class SqlitePumpfunSignals implements PumpfunSignals {
  readonly versions = SIGNAL_VERSIONS;
  private db: BSqlite3Database | null = null;
  private statements: PreparedStatements | null = null;
  private readonly config: SqlitePumpfunSignalsConfig;

  constructor(config: SqlitePumpfunSignalsConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (this.db) return;

    let DB: BSqlite3Constructor;
    try {
      const mod = (await import('better-sqlite3' as string)) as
        | { default: BSqlite3Constructor }
        | BSqlite3Constructor;
      DB = (mod as { default?: BSqlite3Constructor }).default ?? (mod as BSqlite3Constructor);
    } catch {
      throw new Error('SqlitePumpfunSignals requires the `better-sqlite3` peer dependency. Run: pnpm add better-sqlite3');
    }

    const db = new DB(this.config.path);
    try {
      // Tunings mirror the rest of the substrate's sqlite usage.
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous  = NORMAL;');
      db.exec('PRAGMA busy_timeout = 30000;');
      db.exec('PRAGMA temp_store   = MEMORY;');
      db.exec(SCHEMA_SQL);
    } catch (err) {
      db.close();
      throw err;
    }

    this.db = db;
    this.statements = {
      insertEvent: db.prepare(
        `INSERT INTO solana_events (signature, slot, observed_at, mint, wallet, event_type, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      walletTierLatest: db.prepare(
        `SELECT payload FROM solana_events
         WHERE wallet = ? AND event_type = '${EVENT_TYPE.walletTier}' AND observed_at <= ?
         ORDER BY observed_at DESC, id DESC
         LIMIT 1`,
      ),
      convergenceWindow: db.prepare(
        `SELECT wallet, payload, observed_at FROM solana_events
         WHERE mint = ? AND event_type = '${EVENT_TYPE.buy}'
           AND observed_at >= ? AND observed_at <= ?
         ORDER BY observed_at ASC`,
      ),
      milestonesRange: db.prepare(
        `SELECT observed_at, payload FROM solana_events
         WHERE mint = ? AND event_type = '${EVENT_TYPE.milestone}'
           AND observed_at >= ? AND observed_at <= ?
         ORDER BY observed_at ASC, id ASC`,
      ),
      safetyLatest: db.prepare(
        `SELECT payload, observed_at FROM solana_events
         WHERE mint = ? AND event_type = '${EVENT_TYPE.safetyVerdict}' AND observed_at <= ?
         ORDER BY observed_at DESC, id DESC
         LIMIT 1`,
      ),
    };
  }

  // ── Ingest API (specific to the sqlite reference impl) ────────────

  async ingestBuy(args: IngestBuyArgs): Promise<void> {
    const stmts = this.requireStatements();
    const payload = JSON.stringify({
      signature: args.signature,
      slot: args.slot,
      mint: args.mint,
      wallet: args.wallet,
      buyerTier: args.buyerTier ?? null,
      amountSol: args.amountSol ?? null,
    });
    stmts.insertEvent.run(
      args.signature,
      args.slot,
      args.observedAt.getTime(),
      args.mint,
      args.wallet,
      EVENT_TYPE.buy,
      payload,
    );
  }

  async ingestMilestone(args: IngestMilestoneArgs): Promise<void> {
    const stmts = this.requireStatements();
    const payload = JSON.stringify({
      kind: args.kind,
      data: args.data ?? null,
    });
    stmts.insertEvent.run(
      args.signature ?? null,
      args.slot ?? null,
      args.observedAt.getTime(),
      args.mint,
      null,
      EVENT_TYPE.milestone,
      payload,
    );
  }

  async ingestWalletTier(args: IngestWalletTierArgs): Promise<void> {
    const stmts = this.requireStatements();
    const payload = JSON.stringify({ tier: args.tier });
    stmts.insertEvent.run(
      null,
      null,
      args.observedAt.getTime(),
      null,
      args.wallet,
      EVENT_TYPE.walletTier,
      payload,
    );
  }

  async ingestSafetyVerdict(args: IngestSafetyVerdictArgs): Promise<void> {
    const stmts = this.requireStatements();
    const payload = JSON.stringify({
      verdict: args.verdict,
      reasons: args.reasons,
      signals: args.signals,
    });
    stmts.insertEvent.run(
      null,
      null,
      args.observedAt.getTime(),
      args.mint,
      null,
      EVENT_TYPE.safetyVerdict,
      payload,
    );
  }

  // ── PumpfunSignals interface ──────────────────────────────────────

  async walletTier(args: { wallet: string; asOf: Date }): Promise<Tier | null> {
    const stmts = this.requireStatements();
    const row = stmts.walletTierLatest.get(args.wallet, args.asOf.getTime()) as
      | { payload: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.payload) as { tier?: Tier };
    return parsed.tier ?? null;
  }

  async convergenceState(args: {
    mint: string;
    asOf: Date;
    windowMs: number;
  }): Promise<ConvergenceState> {
    const stmts = this.requireStatements();
    const asOfMs = args.asOf.getTime();
    const fromMs = asOfMs - args.windowMs;
    const rows = stmts.convergenceWindow.all(args.mint, fromMs, asOfMs) as Array<{
      wallet: string;
      payload: string;
      observed_at: number;
    }>;

    const distinctByTier: Record<Tier, Set<string>> = {
      S: new Set(), A: new Set(), B: new Set(), C: new Set(), D: new Set(),
    };
    const allBuyers = new Set<string>();
    let firstAt: number | null = null;
    let lastAt: number | null = null;

    for (const r of rows) {
      const parsed = JSON.parse(r.payload) as { buyerTier?: Tier | null };
      allBuyers.add(r.wallet);
      const tier = parsed.buyerTier ?? null;
      if (tier && tier in distinctByTier) {
        distinctByTier[tier].add(r.wallet);
      }
      if (firstAt === null || r.observed_at < firstAt) firstAt = r.observed_at;
      if (lastAt  === null || r.observed_at > lastAt)  lastAt  = r.observed_at;
    }

    return {
      mint:        args.mint,
      asOf:        args.asOf,
      windowMs:    args.windowMs,
      buyersByTier: {
        S: distinctByTier.S.size,
        A: distinctByTier.A.size,
        B: distinctByTier.B.size,
        C: distinctByTier.C.size,
        D: distinctByTier.D.size,
      },
      totalBuyers: allBuyers.size,
      firstBuyAt:  firstAt === null ? null : new Date(firstAt),
      latestBuyAt: lastAt  === null ? null : new Date(lastAt),
    };
  }

  async milestoneEvents(args: {
    mint: string;
    since: Date;
    asOf: Date;
  }): Promise<MilestoneEvent[]> {
    const stmts = this.requireStatements();
    const rows = stmts.milestonesRange.all(
      args.mint,
      args.since.getTime(),
      args.asOf.getTime(),
    ) as Array<{ observed_at: number; payload: string }>;

    return rows.map((r) => {
      const parsed = JSON.parse(r.payload) as {
        kind: MilestoneKind;
        data?: Record<string, unknown> | null;
      };
      const out: MilestoneEvent = {
        mint:       args.mint,
        kind:       parsed.kind,
        observedAt: new Date(r.observed_at),
      };
      if (parsed.data) out.data = parsed.data;
      return out;
    });
  }

  async safetyVerdict(args: { mint: string; asOf: Date }): Promise<SafetyVerdict> {
    const stmts = this.requireStatements();
    const row = stmts.safetyLatest.get(args.mint, args.asOf.getTime()) as
      | { payload: string; observed_at: number } | undefined;
    if (!row) {
      return {
        mint: args.mint,
        asOf: args.asOf,
        verdict: 'unknown',
        reasons: [],
        signals: {},
      };
    }
    const parsed = JSON.parse(row.payload) as {
      verdict: SafetyLabel;
      reasons: string[];
      signals: Record<string, unknown>;
    };
    return {
      mint:    args.mint,
      asOf:    args.asOf,
      verdict: parsed.verdict,
      reasons: parsed.reasons ?? [],
      signals: parsed.signals ?? {},
    };
  }

  async close(): Promise<void> {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.statements = null;
  }

  private requireStatements(): PreparedStatements {
    if (!this.statements) {
      throw new Error('SqlitePumpfunSignals not initialized. Call init() first.');
    }
    return this.statements;
  }
}
