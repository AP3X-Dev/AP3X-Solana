/**
 * drift-reconcile.test.ts — gate 7 integration test (T44)
 *
 * Gate 7: Reconciler drift → strategy sees onPositionChange.
 *
 * The reconciler's full drift-detection logic (CostBasisReconstructor scan +
 * FilePortfolioStore audit comparison) is tested in T18/T19 unit tests in the
 * solana-portfolio package. This test verifies the runtime wiring: that when
 * a PositionChange is emitted by the portfolio store, the strategy's
 * onPositionChange hook fires with the correct before/after.
 *
 * Two approaches tested:
 *   A) Direct applyLandedTrade with source:'external' — simulates what the
 *      reconciler calls when it detects an external/drift transfer.
 *   B) FakePortfolio emitting a 'change' event directly — verifies the
 *      runtime's event wiring in complete isolation from any real store.
 *
 * Both use FilePortfolioStore (approach A) or FakePortfolio (approach B) with
 * StrategyRuntime; no reconciler process is spawned.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { PublicKey } from '@ap3x/solana-core';
import { SignalQueue } from '@ap3x/solana-signals';
import type { Signal } from '@ap3x/solana-signals';
import type { PositionChange, LandedTrade } from '@ap3x/solana-portfolio';
import { FilePortfolioStore } from '@ap3x/solana-portfolio';

import { Strategy } from '../src/strategy.js';
import { StrategyRuntime } from '../src/runtime.js';
import type { SignalFilter } from '../src/filter.js';
import type { StrategyContext } from '../src/context.js';
import {
  makeRuntimeOpts,
  FakeExecutor,
  FakePortfolio,
  makeFakeRpcPool,
  makeFakeResolveWallet,
  MemStateStore,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './_helpers.js';

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let portfolioDir: string;

beforeAll(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `ap3x-drift-reconcile-${process.pid}-${Date.now()}`,
  );
  portfolioDir = path.join(tmpDir, 'portfolio');
  mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// PositionTrackingStrategy — records onPositionChange events
// ---------------------------------------------------------------------------

interface PositionEvent {
  before: PositionChange['before'];
  after: PositionChange['after'];
  reason: PositionChange['reason'];
}

class PositionTrackingStrategy extends Strategy {
  readonly name: string;
  readonly filters: SignalFilter[] = [];
  readonly positionEvents: PositionEvent[] = [];

  constructor(name: string) {
    super();
    this.name = name;
  }

  async onSignal(_sig: Signal, _ctx: StrategyContext): Promise<null> {
    return null;
  }

  override async onPositionChange(change: PositionChange): Promise<void> {
    this.positionEvents.push({
      before: change.before,
      after: change.after,
      reason: change.reason,
    });
  }
}

// ---------------------------------------------------------------------------
// Approach B — FakePortfolio 'change' event wiring
// ---------------------------------------------------------------------------

describe('gate 7 — approach B: runtime wires portfolio change events to onPositionChange', () => {
  it('portfolio emit("change") → strategy onPositionChange fires with correct payload', async () => {
    const { opts, portfolio } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new PositionTrackingStrategy('drift-fake');

    await runtime.register(strategy);
    runtime.start();

    const walletPk = PublicKey.fromBase58(SYSTEM_PROGRAM);
    const mintPk = PublicKey.fromBase58(TOKEN_PROGRAM);

    const change: PositionChange = {
      wallet: walletPk,
      mint: mintPk,
      before: null,
      after: {
        mint: mintPk,
        walletAddress: walletPk,
        lots: [
          {
            amount: 500n,
            costBasisLamports: 0n,
            acquiredSlot: 999,
            acquiredSig: 'external-transfer-sig',
            source: 'transfer-in',
          },
        ],
        lastUpdatedSlot: 999,
      },
      reason: 'apply-landed-trade',
    };

    // Simulate reconciler: emit 'change' on the portfolio
    portfolio.emit('change', change);
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    runtime.stop();

    expect(strategy.positionEvents).toHaveLength(1);
    const evt = strategy.positionEvents[0]!;
    expect(evt.before).toBeNull();
    expect(evt.after.lastUpdatedSlot).toBe(999);
    expect(evt.after.lots).toHaveLength(1);
    expect(evt.after.lots[0]!.amount).toBe(500n);
    expect(evt.reason).toBe('apply-landed-trade');
  });

  it('multiple position changes all reach onPositionChange in order', async () => {
    const { opts, portfolio } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new PositionTrackingStrategy('drift-multi');

    await runtime.register(strategy);
    runtime.start();

    const walletPk = PublicKey.fromBase58(SYSTEM_PROGRAM);
    const mintPk = PublicKey.fromBase58(TOKEN_PROGRAM);

    for (let i = 0; i < 3; i++) {
      const change: PositionChange = {
        wallet: walletPk,
        mint: mintPk,
        before: null,
        after: {
          mint: mintPk,
          walletAddress: walletPk,
          lots: [],
          lastUpdatedSlot: 100 + i,
        },
        reason: 'apply-landed-trade',
      };
      portfolio.emit('change', change);
    }

    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    runtime.stop();

    expect(strategy.positionEvents).toHaveLength(3);
    expect(strategy.positionEvents[0]!.after.lastUpdatedSlot).toBe(100);
    expect(strategy.positionEvents[1]!.after.lastUpdatedSlot).toBe(101);
    expect(strategy.positionEvents[2]!.after.lastUpdatedSlot).toBe(102);
  });
});

// ---------------------------------------------------------------------------
// Approach A — FilePortfolioStore applyLandedTrade with source:'external'
// ---------------------------------------------------------------------------

describe('gate 7 — approach A: FilePortfolioStore applyLandedTrade(source:external) → onPositionChange', () => {
  it('real FilePortfolioStore emits change on external landed trade; strategy receives it', async () => {
    // Gate 7 simpler version: directly call applyLandedTrade with source:'external',
    // which is what the reconciler calls when it detects drift.

    const portfolioStore = new FilePortfolioStore({ dir: portfolioDir });
    const executor = new FakeExecutor();
    const queue = new SignalQueue();

    const runtime = new StrategyRuntime({
      signalQueue: queue,
      executor,
      portfolio: portfolioStore,
      resolveWallet: makeFakeResolveWallet(),
      rpcPool: makeFakeRpcPool() as unknown as import('../src/landed-trade-adapter.js').RpcPoolLike,
      stateStoreFactory: () => new MemStateStore(),
      tickIntervalMs: 999_999,
    });

    const strategy = new PositionTrackingStrategy('drift-real');
    await runtime.register(strategy);
    runtime.start();

    const walletPk = PublicKey.fromBase58(SYSTEM_PROGRAM);
    const mintPk = PublicKey.fromBase58(TOKEN_PROGRAM);

    // Simulate reconciler applying an external transfer (drift detection result)
    const externalTrade: LandedTrade = {
      signature: 'external-drift-sig-001',
      slot: 1234,
      wallet: walletPk,
      mint: mintPk,
      amountDelta: 1_000n,
      solFlowLamports: 0n,
      feeLamports: 0n,
      source: 'external',
    };

    await portfolioStore.applyLandedTrade(externalTrade);
    // Allow position-change to propagate through the instance queue
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    runtime.stop();

    expect(strategy.positionEvents).toHaveLength(1);
    const evt = strategy.positionEvents[0]!;
    expect(evt.before).toBeNull(); // first trade — no prior position
    expect(evt.after.lots).toHaveLength(1);
    expect(evt.after.lots[0]!.amount).toBe(1_000n);
    expect(evt.reason).toBe('apply-landed-trade');
  });

  it('second external trade provides before/after delta — strategy sees prior state', async () => {
    // Verify that after the first trade sets a position, the second trade's
    // PositionChange.before is non-null (the prior position).

    const store2Dir = path.join(portfolioDir, 'store2');
    const portfolioStore = new FilePortfolioStore({ dir: store2Dir });
    const executor = new FakeExecutor();
    const queue = new SignalQueue();

    const runtime = new StrategyRuntime({
      signalQueue: queue,
      executor,
      portfolio: portfolioStore,
      resolveWallet: makeFakeResolveWallet(),
      rpcPool: makeFakeRpcPool() as unknown as import('../src/landed-trade-adapter.js').RpcPoolLike,
      stateStoreFactory: () => new MemStateStore(),
      tickIntervalMs: 999_999,
    });

    const strategy = new PositionTrackingStrategy('drift-delta');
    await runtime.register(strategy);
    runtime.start();

    const walletPk = PublicKey.fromBase58(SYSTEM_PROGRAM);
    const mintPk = PublicKey.fromBase58(TOKEN_PROGRAM);

    // First trade (buy 500)
    await portfolioStore.applyLandedTrade({
      signature: 'drift-trade-1',
      slot: 2000,
      wallet: walletPk,
      mint: mintPk,
      amountDelta: 500n,
      solFlowLamports: -5000n,
      feeLamports: 0n,
      source: 'external',
    });
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    // Second trade (buy another 300)
    await portfolioStore.applyLandedTrade({
      signature: 'drift-trade-2',
      slot: 2001,
      wallet: walletPk,
      mint: mintPk,
      amountDelta: 300n,
      solFlowLamports: -3000n,
      feeLamports: 0n,
      source: 'external',
    });
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    runtime.stop();

    expect(strategy.positionEvents).toHaveLength(2);

    // First event: before is null (no prior position)
    expect(strategy.positionEvents[0]!.before).toBeNull();
    expect(strategy.positionEvents[0]!.after.lots[0]!.amount).toBe(500n);

    // Second event: before is the first position (lots with 500n)
    const before2 = strategy.positionEvents[1]!.before;
    expect(before2).not.toBeNull();
    expect(before2!.lots[0]!.amount).toBe(500n);

    // After second trade: 2 lots
    expect(strategy.positionEvents[1]!.after.lots).toHaveLength(2);
    const totalAfter = strategy.positionEvents[1]!.after.lots.reduce(
      (s, l) => s + l.amount,
      0n,
    );
    expect(totalAfter).toBe(800n);
  });
});

// ---------------------------------------------------------------------------
// Gate 7 — quarantined instance does NOT receive position changes
// ---------------------------------------------------------------------------

describe('gate 7 — quarantined instance skips position change events', () => {
  it('paused strategy does not receive onPositionChange', async () => {
    const { opts, portfolio } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new PositionTrackingStrategy('drift-paused');

    await runtime.register(strategy);
    runtime.start();

    runtime.pause('drift-paused');

    const walletPk = PublicKey.fromBase58(SYSTEM_PROGRAM);
    const mintPk = PublicKey.fromBase58(TOKEN_PROGRAM);

    portfolio.emit('change', {
      wallet: walletPk,
      mint: mintPk,
      before: null,
      after: { mint: mintPk, walletAddress: walletPk, lots: [], lastUpdatedSlot: 5 },
      reason: 'apply-landed-trade',
    } satisfies PositionChange);

    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    runtime.stop();

    // Paused — should not have received the change
    expect(strategy.positionEvents).toHaveLength(0);
  });
});
