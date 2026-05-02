export type {
  BacktestMetrics,
  BacktestTrade,
  ExitReason,
  ExitRules,
  MonteCarloConfig,
  MonteCarloResult,
  PortfolioReplayConfig,
  PortfolioReplayResult,
  PricePoint,
  PriceSeries,
  TradeGate,
} from './types.js';

export { binarySearchFirstGte, walkForwardExit } from './walk-forward.js';
export { computeMetrics } from './metrics.js';
export { replayPortfolio } from './portfolio.js';
export { runHistoricalMonteCarlo, runMonteCarlo } from './monte-carlo.js';
