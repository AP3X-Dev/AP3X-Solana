// ---------------------------------------------------------------------------
// GuardTracker — per-instance strategy guard state machine
//
// Enforces three categories of limits:
//   • Decision rate   — maxDecisionsPerMin (rolling 60-second window)
//   • Error rate      — errorThreshold (configurable window)
//   • Daily P&L loss  — maxLossPerDayLamports (UTC calendar day)
//
// NOTE: maxOpenPositions and drawdownThreshold are intentionally NOT enforced
// here. Both require querying live portfolio state (position count, peak
// equity) which lives outside this class. T42's StrategyRuntime reads those
// config fields and checks them directly against the portfolio before or
// after dispatching, using GuardTracker only for the three stateful counters
// above.
// ---------------------------------------------------------------------------

export interface GuardConfig {
  /** Maximum decisions allowed per rolling 60-second window. Default: 60. */
  maxDecisionsPerMin?: number;
  /**
   * Maximum concurrent open positions allowed.
   * Enforced by StrategyRuntime against portfolio state — NOT by GuardTracker.
   */
  maxOpenPositions?: number;
  /** Lamports of daily realized loss before the guard trips. Default: unlimited. */
  maxLossPerDayLamports?: bigint;
  /** Error count + window that triggers a trip. Default: 5 errors / 60 000 ms. */
  errorThreshold?: { errors: number; windowMs: number };
  /**
   * Maximum drawdown (lamports from peak equity) allowed.
   * Enforced by StrategyRuntime against portfolio state — NOT by GuardTracker.
   */
  drawdownThreshold?: bigint;
}

export type GuardTrip = {
  guard: keyof GuardConfig;
  /** Number for count-based guards; bigint for lamport-denominated guards. */
  value: number | bigint;
};

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/** Returns the UTC timestamp of midnight at the start of the day containing `ts`. */
function startOfDayUtc(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------------------------------------------------------------------------
// GuardTracker
// ---------------------------------------------------------------------------

export class GuardTracker {
  private decisionTimes: number[] = [];
  private errorTimes: number[] = [];
  private realizedToday: bigint = 0n;
  private dayStartTs: number;

  constructor(
    private readonly cfg: GuardConfig,
    private readonly clock: () => number = Date.now,
  ) {
    this.dayStartTs = startOfDayUtc(clock());
  }

  // -------------------------------------------------------------------------
  // recordDecision — rolling 60-second window rate limit
  // -------------------------------------------------------------------------

  recordDecision(): GuardTrip | null {
    const now = this.clock();
    this.decisionTimes = this.decisionTimes.filter((t) => now - t < 60_000);
    this.decisionTimes.push(now);
    const max = this.cfg.maxDecisionsPerMin ?? 60;
    if (this.decisionTimes.length > max) {
      return { guard: 'maxDecisionsPerMin', value: this.decisionTimes.length };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // recordError — rolling configurable-window error count
  // -------------------------------------------------------------------------

  recordError(): GuardTrip | null {
    const windowMs = this.cfg.errorThreshold?.windowMs ?? 60_000;
    const now = this.clock();
    this.errorTimes = this.errorTimes.filter((t) => now - t < windowMs);
    this.errorTimes.push(now);
    const max = this.cfg.errorThreshold?.errors ?? 5;
    if (this.errorTimes.length > max) {
      return { guard: 'errorThreshold', value: this.errorTimes.length };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // recordRealized — cumulative UTC-day P&L loss cap
  //
  // `amount` is signed: positive = profit, negative = loss.
  // Trip condition: realizedToday < -maxLossPerDayLamports
  //   e.g. limit=100n, realizedToday=-101n  →  -101n < -100n  →  trip
  //        limit=100n, realizedToday=-100n  →  -100n < -100n  →  false (exactly at limit, no trip)
  // -------------------------------------------------------------------------

  recordRealized(amount: bigint): GuardTrip | null {
    const now = this.clock();
    const todayStart = startOfDayUtc(now);
    if (todayStart !== this.dayStartTs) {
      this.dayStartTs = todayStart;
      this.realizedToday = 0n;
    }
    this.realizedToday += amount;
    if (
      this.cfg.maxLossPerDayLamports !== undefined &&
      this.realizedToday < -this.cfg.maxLossPerDayLamports
    ) {
      return { guard: 'maxLossPerDayLamports', value: this.realizedToday };
    }
    return null;
  }
}
