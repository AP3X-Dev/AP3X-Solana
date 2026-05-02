import type { BacktestTrade, PortfolioReplayConfig, PortfolioReplayResult } from './types.js';

interface OpenPosition {
  readonly exitTimeMs: number;
  readonly amount: number;
  readonly roi: number;
}

/**
 * Replays completed trades through fixed-size portfolio accounting.
 *
 * Cash is reduced by `tradeSize` at entry and restored as
 * `tradeSize * roi` at exit. Open positions are carried at cost basis,
 * so entries do not create artificial drawdown. Drawdown is measured on
 * cash + open cost basis after realized exits.
 */
export function replayPortfolio(
  trades: readonly BacktestTrade[],
  config: PortfolioReplayConfig,
): PortfolioReplayResult {
  const ordered = [...trades].sort((a, b) => tradeEntryTime(a) - tradeEntryTime(b));
  const maxConcurrent = config.maxConcurrent ?? Number.POSITIVE_INFINITY;
  let cash = config.startCapital;
  let peakEquity = config.startCapital;
  let maxDrawdown = 0;
  let tradesTaken = 0;
  let tradesSkipped = 0;
  const open: OpenPosition[] = [];

  function equity(): number {
    return cash + open.reduce((sum, p) => sum + p.amount, 0);
  }

  function mark(): void {
    const current = equity();
    peakEquity = Math.max(peakEquity, current);
    if (peakEquity > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peakEquity - current) / peakEquity);
    }
  }

  function closeUntil(ts: number): void {
    open.sort((a, b) => a.exitTimeMs - b.exitTimeMs);
    while (open.length > 0 && open[0]!.exitTimeMs <= ts) {
      const position = open.shift()!;
      cash += position.amount * position.roi;
      mark();
    }
  }

  for (const trade of ordered) {
    const entryTimeMs = tradeEntryTime(trade);
    closeUntil(entryTimeMs);

    if (open.length >= maxConcurrent || cash < config.tradeSize) {
      tradesSkipped++;
      continue;
    }

    cash -= config.tradeSize;
    open.push({
      exitTimeMs: tradeExitTime(trade, entryTimeMs),
      amount: config.tradeSize,
      roi: trade.roi,
    });
    tradesTaken++;
    mark();
  }

  closeUntil(Number.POSITIVE_INFINITY);
  mark();

  const finalEquity = equity();
  return {
    finalEquity,
    returnPct: (finalEquity / config.startCapital - 1) * 100,
    maxDrawdown,
    peakEquity,
    tradesTaken,
    tradesSkipped,
  };
}

function tradeEntryTime(trade: BacktestTrade): number {
  return trade.entryTimeMs ?? 0;
}

function tradeExitTime(trade: BacktestTrade, entryTimeMs: number): number {
  return trade.exitTimeMs ?? entryTimeMs + trade.holdMinutes * 60_000;
}
