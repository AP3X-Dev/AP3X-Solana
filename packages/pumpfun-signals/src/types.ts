/**
 * Wallet quality classification. Tier letters get progressively lower-quality
 * left-to-right; products use a threshold (e.g. "S+A only") for buy-pressure
 * signals.
 */
export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';

/**
 * State of buy-pressure convergence on a mint within a time window. Returned
 * as observed-at-or-before `asOf`. The shape is deliberately raw — products
 * apply their own threshold (N buyers of which tiers within window) on top.
 */
export interface ConvergenceState {
  mint: string;
  asOf: Date;
  windowMs: number;
  /** Distinct buyers per tier, counted at-or-before asOf within the window. */
  buyersByTier: Record<Tier, number>;
  /** Distinct buyers across all tiers, counted at-or-before asOf within the window. */
  totalBuyers: number;
  /** Earliest in-window buy ≤ asOf. `null` when nobody has bought. */
  firstBuyAt: Date | null;
  /** Most recent in-window buy ≤ asOf. `null` when nobody has bought. */
  latestBuyAt: Date | null;
}

/** A pump.fun lifecycle milestone for a single mint. */
export interface MilestoneEvent {
  mint: string;
  kind: MilestoneKind;
  observedAt: Date;
  /** Vertical-specific payload (price, fdv, slot, signature, etc.). Opaque to consumers. */
  data?: Record<string, unknown>;
}

export type MilestoneKind =
  | 'created'
  | 'first-buy'
  | 'fdv-10k'
  | 'fdv-50k'
  | 'fdv-100k'
  | 'graduated'
  | 'ath'
  | 'rugged'
  | 'dev-sold';

/** Safety classification of a token. */
export interface SafetyVerdict {
  mint: string;
  asOf: Date;
  verdict: SafetyLabel;
  /** Human-readable reasons that contributed to the verdict. */
  reasons: string[];
  /** Raw signals (mint authority, freeze authority, dev-bundled flag, top-holder concentration, etc.). Opaque. */
  signals: Record<string, unknown>;
}

export type SafetyLabel = 'safe' | 'warning' | 'danger' | 'unknown';

/**
 * Stable, narrow signal API for pump.fun. Every method takes `asOf` and
 * guarantees no data observed *after* `asOf` appears in the response — the
 * defining property for honest backtests. Per-method `signal_version`
 * strings appear in `versions`; bumping a version is a breaking change to
 * that method's semantics.
 */
export interface PumpfunSignals {
  /**
   * Wallet quality classification observed at-or-before `asOf`. Returns the
   * most recent classification on or before `asOf`, or `null` if the wallet
   * has never been classified.
   */
  walletTier(args: { wallet: string; asOf: Date }): Promise<Tier | null>;

  /**
   * Buy-pressure state for `mint` within `[asOf - windowMs, asOf]`. The
   * window is inclusive on both ends. Counts are over distinct wallets
   * (not distinct buys).
   */
  convergenceState(args: { mint: string; asOf: Date; windowMs: number }): Promise<ConvergenceState>;

  /**
   * Every lifecycle milestone for `mint` observed in `[since, asOf]`,
   * inclusive on both ends, in observedAt-ascending order.
   */
  milestoneEvents(args: { mint: string; since: Date; asOf: Date }): Promise<MilestoneEvent[]>;

  /**
   * Most recent safety verdict observed at-or-before `asOf`. Returns
   * `verdict: 'unknown'` with empty reasons if the mint has never been
   * classified.
   */
  safetyVerdict(args: { mint: string; asOf: Date }): Promise<SafetyVerdict>;

  /** Per-method version pins for honest backtests. */
  readonly versions: PumpfunSignalsVersions;
}

export interface PumpfunSignalsVersions {
  walletTier: string;
  convergenceState: string;
  milestoneEvents: string;
  safetyVerdict: string;
}
