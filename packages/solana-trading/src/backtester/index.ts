export type {
  BacktestMetrics,
  BacktestTrade,
  ExitReason,
  ExitRules,
  MonteCarloConfig,
  MonteCarloResult,
  PricePoint,
  PriceSeries,
  TradeGate,
} from './types.js';

export { binarySearchFirstGte, walkForwardExit } from './walk-forward.js';
export { computeMetrics } from './metrics.js';
export { runMonteCarlo } from './monte-carlo.js';
