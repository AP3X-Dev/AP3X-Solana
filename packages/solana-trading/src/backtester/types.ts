/**
 * Backtester type definitions for price-series trading strategies.
 *
 * These primitives support walk-forward simulation, Monte Carlo
 * portfolio projection, and fitness-scored strategy evaluation.
 */

/** A single price observation in a time series. */
export interface PricePoint {
  readonly ts: number;    // unix ms
  readonly price: number; // USD
}

/** A complete price series for one token. */
export interface PriceSeries {
  readonly mint: string;
  readonly points: readonly PricePoint[];
}

/** A conditional entry gate (feature threshold check). */
export interface TradeGate {
  readonly featureName: string;
  readonly operator: '>=' | '<=';
  readonly threshold: number;
  readonly enabled: boolean;
}

/** Rules governing when a position exits. */
export interface ExitRules {
  readonly holdMinutes: number;
  readonly hardStopPct: number;
  readonly takeProfitMultiple: number;
  readonly trailingStopPct: number;
  readonly trailingActivationMultiple: number;
}

/** Why a trade exited. */
export type ExitReason = 'time' | 'hard_stop' | 'take_profit' | 'trailing_stop' | 'end_of_data';

/** Result of a single simulated trade. */
export interface BacktestTrade {
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly roi: number;
  readonly holdMinutes: number;
  readonly exitReason: ExitReason;
}

/** Aggregate metrics for a set of backtest trades. */
export interface BacktestMetrics {
  readonly tradeCount: number;
  readonly winRate: number;
  readonly meanRoi: number;
  readonly medianRoi: number;
  readonly sharpeRatio: number;
  readonly maxDrawdown: number;
  readonly fitness: number;
}

/** Configuration for Monte Carlo portfolio simulation. */
export interface MonteCarloConfig {
  readonly runs: number;
  readonly days: number;
  readonly startCapital: number;
  readonly tradeSize: number;
  readonly maxConcurrent: number;
  readonly seed: number;
}

/** Result of a Monte Carlo simulation. */
export interface MonteCarloResult {
  readonly medianFinal: number;
  readonly medianReturn: number;
  readonly p10: number;
  readonly p25: number;
  readonly p75: number;
  readonly p90: number;
  readonly bustRate: number;
  readonly avgTradesTaken: number;
}
