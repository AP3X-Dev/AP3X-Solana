/**
 * backtest.test.ts — Tests for the runBacktest harness (T43)
 *
 * Gate 6 determinism: running twice with the same clock + rng + fixture
 * must produce byte-identical decisionLog + lifecycleLog.
 *
 * Fixture strategy: AlwaysDecideStrategy — decides on every matching signal.
 *
 * Fixture signals: 3-5 signals written to a temp .jsonl.gz file per test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PublicKey } from '@ap3x/solana-core';
import { FixtureSignalSource } from '@ap3x/solana-signals';
import type { Signal } from '@ap3x/solana-signals';
import type { TradeIntent, ExecutionResult } from '@ap3x/solana-executor';
import type { LandedTrade } from '@ap3x/solana-portfolio';

import { Strategy } from './strategy.js';
import type { StrategyContext } from './context.js';
import type { SignalFilter } from './filter.js';
import { runBacktest } from './backtest.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Known valid 32-byte base58 Solana addresses */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

let tmpDir: string;

beforeAll(() => {
  tmpDir = path.join(os.tmpdir(), `ap3x-backtest-test-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/**
 * Write a gzipped JSONL fixture file. Signals have programId serialised as
 * base58 string (FixtureSignalSource.parseSignal will reconstruct PublicKey).
 */
function writeFixture(filename: string, signals: Signal[]): string {
  const lines = signals.map((s) =>
    JSON.stringify({
      ...s,
      programId: s.programId.toBase58(),
      raw: { ...s.raw, programId: s.raw.programId as unknown as string },
    }),
  );
  const jsonl = lines.join('\n') + '\n';
  const gz = gzipSync(Buffer.from(jsonl, 'utf8'));
  const fpath = path.join(tmpDir, filename);
  writeFileSync(fpath, gz);
  return fpath;
}

/** Build a test Signal. */
function makeSignal(
  id: string,
  kind: string,
  slot: number,
  ts: number,
): Signal {
  return {
    signalId: id,
    ts,
    slot,
    signature: `sig-${id}`,
    programId: PublicKey.fromBase58(SYSTEM_PROGRAM),
    kind,
    decoded: { test: true },
    raw: {
      slot,
      signature: `sig-${id}`,
      programId: SYSTEM_PROGRAM,
      logs: [],
    } as unknown as Signal['raw'],
  };
}

/** Deterministic counter clock — returns monotonically increasing integers. */
function makeCounterClock(start = 1000): () => number {
  let n = start;
  return () => n++;
}

// ---------------------------------------------------------------------------
// Strategies under test
// ---------------------------------------------------------------------------

/** Decides on every signal that matches the filter. */
class AlwaysDecideStrategy extends Strategy {
  readonly name = 'always-decide';
  readonly filters: SignalFilter[] = [{ kind: 'swap' }];

  async onSignal(_sig: Signal, _ctx: StrategyContext): Promise<TradeIntent | null> {
    return {
      intentId: '', // overridden by runtime
      wallet: 'main',
      instructions: [],
      feeTier: 'med' as const,
      deadline: 9_999_999_999,
    };
  }
}

/** Never decides — always returns null. */
class NeverDecideStrategy extends Strategy {
  readonly name = 'never-decide';
  readonly filters: SignalFilter[] = [{ kind: 'swap' }];

  async onSignal(_sig: Signal, _ctx: StrategyContext): Promise<null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_SIGNALS_5: Signal[] = [
  makeSignal('s1', 'swap', 100, 1001),
  makeSignal('s2', 'swap', 101, 1002),
  makeSignal('s3', 'swap', 102, 1003),
  makeSignal('s4', 'mint', 103, 1004), // kind: 'mint' — should NOT be picked up by swap filter
  makeSignal('s5', 'swap', 104, 1005),
];

function makeMintPk(): PublicKey {
  return PublicKey.fromBase58(TOKEN_PROGRAM);
}

// ---------------------------------------------------------------------------
// Test 1 — Gate 6 determinism: two runs produce byte-identical logs
// ---------------------------------------------------------------------------

describe('runBacktest — gate 6 determinism', () => {
  it('produces byte-identical decisionLog + lifecycleLog when run twice with same inputs', async () => {
    const fixturePath = writeFixture('gate6.jsonl.gz', FIXTURE_SIGNALS_5);

    async function oneRun(): Promise<{ dl: string; ll: string }> {
      const clock = makeCounterClock(1000);
      // Use explicit mulberry32 seed=0 both runs so rng sequence is identical
      let rngState = 0;
      const deterministicRng = (): number => {
        rngState = (rngState + 0x6d2b79f5) >>> 0;
        let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      const result = await runBacktest({
        strategy: new AlwaysDecideStrategy(),
        fixtureSource: new FixtureSignalSource({ path: fixturePath }),
        clock,
        rng: deterministicRng,
      });
      return {
        dl: JSON.stringify(result.decisionLog),
        ll: JSON.stringify(result.lifecycleLog),
      };
    }

    const run1 = await oneRun();
    const run2 = await oneRun();

    expect(run1.dl).toBe(run2.dl);
    expect(run1.ll).toBe(run2.ll);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Landing failures with landingSuccessRate < 1.0 are deterministic
// ---------------------------------------------------------------------------

describe('runBacktest — deterministic landing failures', () => {
  it('passes through landing failures (landingSuccessRate < 1.0) deterministically', async () => {
    const fixturePath = writeFixture('landing.jsonl.gz', FIXTURE_SIGNALS_5);

    // landingSuccessRate = 0.5 — with mulberry32(0), first call is ~0.54, so
    // some land and some don't. Two runs must produce the same decisionLog.
    async function oneRun(): Promise<string> {
      let rngState = 0;
      const rng = (): number => {
        rngState = (rngState + 0x6d2b79f5) >>> 0;
        let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      const clock = makeCounterClock(2000);
      const result = await runBacktest({
        strategy: new AlwaysDecideStrategy(),
        fixtureSource: new FixtureSignalSource({ path: fixturePath }),
        clock,
        rng,
        simulatedExecutor: { landingSuccessRate: 0.5 },
      });
      return JSON.stringify(result.decisionLog);
    }

    const dl1 = await oneRun();
    const dl2 = await oneRun();
    expect(dl1).toBe(dl2);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — trades[] contains the TradeIntents emitted by the strategy
// ---------------------------------------------------------------------------

describe('runBacktest — trades[] field', () => {
  it('records trades emitted by the strategy in the trades[] field', async () => {
    // 3 swap signals, 1 mint signal → 3 decisions
    const fixturePath = writeFixture('trades.jsonl.gz', FIXTURE_SIGNALS_5);
    const clock = makeCounterClock(3000);

    const result = await runBacktest({
      strategy: new AlwaysDecideStrategy(),
      fixtureSource: new FixtureSignalSource({ path: fixturePath }),
      clock,
    });

    // 4 swap signals match the filter (s1, s2, s3, s5); s4 is 'mint' → filtered
    expect(result.trades).toHaveLength(4);
    for (const trade of result.trades) {
      expect(trade.wallet).toBe('main');
      expect(trade.feeTier).toBe('med');
      expect(trade.intentId).toBeTruthy();
    }
  });

  it('records no trades when strategy always returns null', async () => {
    const fixturePath = writeFixture('no-trades.jsonl.gz', FIXTURE_SIGNALS_5);
    const clock = makeCounterClock(4000);

    const result = await runBacktest({
      strategy: new NeverDecideStrategy(),
      fixtureSource: new FixtureSignalSource({ path: fixturePath }),
      clock,
    });

    expect(result.trades).toHaveLength(0);
    expect(result.decisionLog).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Without intentToTrade callback, finalPositions is empty
// ---------------------------------------------------------------------------

describe('runBacktest — intentToTrade absent', () => {
  it('with no intentToTrade callback, finalPositions is empty and realizedPnl is 0n', async () => {
    const fixturePath = writeFixture('no-itf.jsonl.gz', FIXTURE_SIGNALS_5);
    const clock = makeCounterClock(5000);

    const result = await runBacktest({
      strategy: new AlwaysDecideStrategy(),
      fixtureSource: new FixtureSignalSource({ path: fixturePath }),
      clock,
    });

    // No intentToTrade → no portfolio mutations
    expect(result.finalPositions).toHaveLength(0);
    expect(result.realizedPnl).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — With intentToTrade callback, applies trades and reports realizedPnl
// ---------------------------------------------------------------------------

describe('runBacktest — intentToTrade provided', () => {
  it('applies trades to portfolio and reports realizedPnl when intentToTrade is supplied', async () => {
    const mint = makeMintPk();

    // Buy on first signal (amountDelta > 0), sell on subsequent ones
    // For simplicity: all trades are buys (amountDelta=+100n, solFlowLamports=-1000n)
    // → realizedPnl should be 0 (no sells)
    const fixturePath = writeFixture('with-itf.jsonl.gz', FIXTURE_SIGNALS_5);
    const clock = makeCounterClock(6000);

    const intentToTrade = (
      intent: TradeIntent,
      result: ExecutionResult,
    ): LandedTrade[] => {
      if (result.kind !== 'landed') return [];
      return [
        {
          signature: (result as { kind: 'landed'; signature: string }).signature,
          slot: (result as { kind: 'landed'; slot: number }).slot,
          wallet: PublicKey.fromBase58(SYSTEM_PROGRAM),
          mint,
          amountDelta: 100n,
          solFlowLamports: -1000n,
          feeLamports: 5000n,
          source: 'executor',
        },
      ];
    };

    const result = await runBacktest({
      strategy: new AlwaysDecideStrategy(),
      fixtureSource: new FixtureSignalSource({ path: fixturePath }),
      clock,
      intentToTrade,
    });

    // 4 swap signals (s1, s2, s3, s5) → 4 buys → 1 position with 4 lots
    expect(result.finalPositions).toHaveLength(1); // 1 mint, aggregated lots
    const pos = result.finalPositions[0] as { lots: Array<{ amount: bigint }> };
    // Total: 4 lots of 100n each
    const totalAmount = pos.lots.reduce((s: bigint, l: { amount: bigint }) => s + l.amount, 0n);
    expect(totalAmount).toBe(400n);

    // No sells → no realized PnL
    expect(result.realizedPnl).toBe(0n);
  });

  it('realizes PnL when intentToTrade produces a sell after a buy', async () => {
    const mint = makeMintPk();
    // Write exactly 2 signals: buy then sell
    const twoSignals: Signal[] = [
      makeSignal('buy-1', 'swap', 200, 2001),
      makeSignal('sell-1', 'swap', 201, 2002),
    ];
    const fixturePath = writeFixture('pnl.jsonl.gz', twoSignals);
    const clock = makeCounterClock(7000);

    let callCount = 0;
    const intentToTrade = (
      _intent: TradeIntent,
      result: ExecutionResult,
    ): LandedTrade[] => {
      if (result.kind !== 'landed') return [];
      callCount++;
      const r = result as { kind: 'landed'; signature: string; slot: number };
      if (callCount === 1) {
        // Buy 1000 tokens for 10_000n SOL
        return [
          {
            signature: r.signature,
            slot: r.slot,
            wallet: PublicKey.fromBase58(SYSTEM_PROGRAM),
            mint,
            amountDelta: 1000n,
            solFlowLamports: -10_000n,
            feeLamports: 5000n,
            source: 'executor',
          },
        ];
      } else {
        // Sell 1000 tokens for 12_000n SOL
        return [
          {
            signature: r.signature,
            slot: r.slot,
            wallet: PublicKey.fromBase58(SYSTEM_PROGRAM),
            mint,
            amountDelta: -1000n,
            solFlowLamports: 12_000n,
            feeLamports: 5000n,
            source: 'executor',
          },
        ];
      }
    };

    const result = await runBacktest({
      strategy: new AlwaysDecideStrategy(),
      fixtureSource: new FixtureSignalSource({ path: fixturePath }),
      clock,
      intentToTrade,
    });

    // Should have realized PnL: proceeds(12_000) - costBasis(10_000) = 2_000
    expect(result.realizedPnl).toBe(2_000n);
    // Position lots should be empty after full sell
    expect(result.finalPositions).toHaveLength(1);
    const pos = result.finalPositions[0] as { lots: unknown[] };
    expect(pos.lots).toHaveLength(0);
  });
});
