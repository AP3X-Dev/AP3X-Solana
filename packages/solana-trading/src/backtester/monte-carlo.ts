/**
 * Monte Carlo portfolio simulation.
 *
 * Projects a strategy's ROI distribution over N days with position
 * sizing, concurrent slot limits, and bankroll management. Returns
 * percentile distribution of final portfolio values.
 */

import { replayPortfolio } from './portfolio.js';
import type { BacktestTrade, MonteCarloConfig, MonteCarloResult } from './types.js';

/**
 * Runs a Monte Carlo simulation projecting portfolio performance.
 *
 * @param roiPool - historical per-trade ROI values to sample from
 * @param holdHoursPool - historical per-trade hold durations (hours)
 * @param alertsPerDay - observed signal frequency
 * @param config - simulation parameters
 */
export function runMonteCarlo(
  roiPool: readonly number[],
  holdHoursPool: readonly number[],
  alertsPerDay: number,
  config: MonteCarloConfig,
): MonteCarloResult {
  if (roiPool.length === 0) {
    return { medianFinal: config.startCapital, medianReturn: 0, p10: config.startCapital, p25: config.startCapital, p75: config.startCapital, p90: config.startCapital, bustRate: 0, avgTradesTaken: 0 };
  }

  let rngState = config.seed;
  function rng(): number {
    rngState = (rngState * 1664525 + 1013904223) | 0;
    return (rngState >>> 0) / 0xFFFFFFFF;
  }

  const finals: number[] = [];
  const drawdowns: number[] = [];
  let totalTrades = 0;
  let totalSkipped = 0;

  for (let run = 0; run < config.runs; run++) {
    const result = simulateOneRun(rng, roiPool, holdHoursPool, alertsPerDay, config);
    finals.push(result.final);
    totalTrades += result.taken;
    totalSkipped += result.skipped;
    drawdowns.push(result.maxDrawdown);
  }

  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  const p = (pct: number) => finals[Math.floor(pct / 100 * (finals.length - 1))]!;
  const dd = (pct: number) => drawdowns[Math.floor(pct / 100 * (drawdowns.length - 1))]!;
  const median = p(50);
  const bust = finals.filter(v => v < config.startCapital * 0.33).length;

  return {
    medianFinal: median,
    medianReturn: (median / config.startCapital - 1) * 100,
    p10: p(10),
    p25: p(25),
    p75: p(75),
    p90: p(90),
    bustRate: (bust / config.runs) * 100,
    avgTradesTaken: totalTrades / config.runs,
    avgTradesSkipped: totalSkipped / config.runs,
    medianMaxDrawdown: dd(50),
    p90MaxDrawdown: dd(90),
  };
}

/**
 * Runs a day-block bootstrap Monte Carlo from historical trades.
 *
 * Instead of sampling independent ROIs and distributing them uniformly,
 * this resamples whole historical days. That preserves intraday signal
 * clustering and same-day loss correlation before applying fixed-size
 * portfolio replay.
 */
export function runHistoricalMonteCarlo(
  trades: readonly BacktestTrade[],
  config: MonteCarloConfig,
): MonteCarloResult {
  const timedTrades = trades.filter((t): t is BacktestTrade & { readonly entryTimeMs: number } => t.entryTimeMs !== undefined);
  if (timedTrades.length === 0) {
    return runMonteCarlo(
      trades.map(t => t.roi),
      trades.map(t => t.holdMinutes / 60),
      trades.length / Math.max(config.days, 1),
      config,
    );
  }

  let rngState = config.seed;
  function rng(): number {
    rngState = (rngState * 1664525 + 1013904223) | 0;
    return (rngState >>> 0) / 0xFFFFFFFF;
  }

  const dayMs = 86_400_000;
  const blocks = buildDailyBlocks(timedTrades, dayMs);
  const finals: number[] = [];
  const drawdowns: number[] = [];
  let totalTrades = 0;
  let totalSkipped = 0;

  for (let run = 0; run < config.runs; run++) {
    const sampled: BacktestTrade[] = [];
    for (let day = 0; day < config.days; day++) {
      const block = blocks[Math.floor(rng() * blocks.length)]!;
      for (const trade of block.trades) {
        const entryOffset = trade.entryTimeMs! - block.dayStartMs;
        const entryTimeMs = day * dayMs + entryOffset;
        const durationMs = trade.exitTimeMs !== undefined
          ? Math.max(0, trade.exitTimeMs - trade.entryTimeMs!)
          : trade.holdMinutes * 60_000;
        sampled.push({
          ...trade,
          entryTimeMs,
          exitTimeMs: entryTimeMs + durationMs,
        });
      }
    }

    const replay = replayPortfolio(sampled, {
      startCapital: config.startCapital,
      tradeSize: config.tradeSize,
      maxConcurrent: config.maxConcurrent,
    });
    finals.push(replay.finalEquity);
    drawdowns.push(replay.maxDrawdown);
    totalTrades += replay.tradesTaken;
    totalSkipped += replay.tradesSkipped;
  }

  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  const p = (pct: number) => finals[Math.floor(pct / 100 * (finals.length - 1))]!;
  const dd = (pct: number) => drawdowns[Math.floor(pct / 100 * (drawdowns.length - 1))]!;
  const median = p(50);
  const bust = finals.filter(v => v < config.startCapital * 0.33).length;

  return {
    medianFinal: median,
    medianReturn: (median / config.startCapital - 1) * 100,
    p10: p(10),
    p25: p(25),
    p75: p(75),
    p90: p(90),
    bustRate: (bust / config.runs) * 100,
    avgTradesTaken: totalTrades / config.runs,
    avgTradesSkipped: totalSkipped / config.runs,
    medianMaxDrawdown: dd(50),
    p90MaxDrawdown: dd(90),
  };
}

function buildDailyBlocks(
  trades: readonly (BacktestTrade & { readonly entryTimeMs: number })[],
  dayMs: number,
): Array<{ readonly dayStartMs: number; readonly trades: readonly BacktestTrade[] }> {
  const byDay = new Map<number, BacktestTrade[]>();
  for (const trade of trades) {
    const dayStartMs = Math.floor(trade.entryTimeMs / dayMs) * dayMs;
    const block = byDay.get(dayStartMs) ?? [];
    block.push(trade);
    byDay.set(dayStartMs, block);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([dayStartMs, blockTrades]) => ({
      dayStartMs,
      trades: blockTrades.sort((a, b) => (a.entryTimeMs ?? 0) - (b.entryTimeMs ?? 0)),
    }));
}

function simulateOneRun(
  rng: () => number,
  roiPool: readonly number[],
  holdHoursPool: readonly number[],
  alertsPerDay: number,
  config: MonteCarloConfig,
): { final: number; taken: number; skipped: number; maxDrawdown: number } {
  let bankroll = config.startCapital;
  const busyUntil = new Array(config.maxConcurrent).fill(0) as number[];
  const pendingAmount = new Array(config.maxConcurrent).fill(0) as number[];
  const pendingRoi = new Array(config.maxConcurrent).fill(1) as number[];
  let peakEquity = config.startCapital;
  let maxDrawdown = 0;

  const nAlerts = Math.round(alertsPerDay * config.days);
  const times: number[] = [];
  for (let i = 0; i < nAlerts; i++) times.push(rng() * config.days * 24);
  times.sort((a, b) => a - b);

  let taken = 0;
  let skipped = 0;
  function mark(): void {
    const openCost = pendingAmount.reduce((sum, amount) => sum + amount, 0);
    const equity = bankroll + openCost;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
  }

  for (const t of times) {
    // Close completed positions
    for (let i = 0; i < config.maxConcurrent; i++) {
      if (busyUntil[i]! > 0 && busyUntil[i]! <= t) {
        bankroll += pendingAmount[i]! * pendingRoi[i]!;
        busyUntil[i] = 0;
        pendingAmount[i] = 0;
        pendingRoi[i] = 1;
        mark();
      }
    }

    // Find free slot
    const idx = busyUntil.findIndex(b => b === 0);
    if (idx === -1 || bankroll < config.tradeSize) {
      skipped++;
      continue;
    }

    // Take trade
    const tradeIdx = Math.floor(rng() * roiPool.length);
    bankroll -= config.tradeSize;
    busyUntil[idx] = t + holdHoursPool[tradeIdx]!;
    pendingAmount[idx] = config.tradeSize;
    pendingRoi[idx] = roiPool[tradeIdx]!;
    taken++;
    mark();
  }

  // Close remaining
  for (let i = 0; i < config.maxConcurrent; i++) {
    if (busyUntil[i]! > 0) {
      bankroll += pendingAmount[i]! * pendingRoi[i]!;
      pendingAmount[i] = 0;
      mark();
    }
  }

  return { final: bankroll, taken, skipped, maxDrawdown };
}
