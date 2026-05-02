/**
 * Aggregate metrics computation for backtest trade results.
 *
 * Computes Sharpe ratio, max drawdown, win rate, and a composite
 * fitness score that balances risk-adjusted return with signal participation.
 */

import { replayPortfolio } from './portfolio.js';
import type { BacktestMetrics, BacktestTrade, PortfolioReplayConfig } from './types.js';

/**
 * Computes aggregate metrics for a set of backtest trades.
 *
 * @param trades - completed trades with ROI values
 * @param totalSignals - total number of signals evaluated (for participation scoring)
 * @param minTrades - minimum trades required; returns -Infinity fitness if below
 */
export function computeMetrics(
  trades: readonly BacktestTrade[],
  totalSignals: number,
  minTrades = 20,
  portfolioConfig?: PortfolioReplayConfig,
): BacktestMetrics {
  if (trades.length < minTrades) {
    return {
      tradeCount: trades.length,
      winRate: 0,
      meanRoi: 0,
      medianRoi: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      fitness: -Infinity,
    };
  }

  const rois = trades.map(t => t.roi);
  const returns = rois.map(r => r - 1);

  // Mean and standard deviation of returns
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? mean / std : 0;

  // Median ROI
  const sorted = [...rois].sort((a, b) => a - b);
  const medianRoi = sorted[Math.floor(sorted.length / 2)]!;

  // Win rate
  const winRate = rois.filter(r => r > 1).length / rois.length;

  // Mean ROI
  const meanRoi = rois.reduce((a, b) => a + b, 0) / rois.length;

  const portfolio = portfolioConfig !== undefined
    ? replayPortfolio(trades, portfolioConfig)
    : undefined;
  const maxDd = portfolio?.maxDrawdown ?? computeCompoundedRoiDrawdown(rois);

  // Fitness: Sharpe * sqrt(participation)
  // Rewards both risk-adjusted returns and taking enough trades
  const participation = Math.sqrt(trades.length / totalSignals);
  const drawdownPenalty = portfolioConfig !== undefined ? Math.max(0, 1 - maxDd) ** 2 : 1;
  const medianPenalty = portfolioConfig !== undefined && medianRoi < 1 ? Math.max(0, medianRoi) : 1;
  const fitness = sharpe * participation * drawdownPenalty * medianPenalty;

  return {
    tradeCount: trades.length,
    winRate,
    meanRoi,
    medianRoi,
    sharpeRatio: sharpe,
    maxDrawdown: maxDd,
    ...(portfolio !== undefined ? {
      portfolioFinal: portfolio.finalEquity,
      portfolioReturn: portfolio.returnPct,
      tradesSkipped: portfolio.tradesSkipped,
    } : {}),
    fitness,
  };
}

function computeCompoundedRoiDrawdown(rois: readonly number[]): number {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of rois) {
    equity *= r;
    peak = Math.max(peak, equity);
    const dd = (peak - equity) / peak;
    maxDd = Math.max(maxDd, dd);
  }
  return maxDd;
}
