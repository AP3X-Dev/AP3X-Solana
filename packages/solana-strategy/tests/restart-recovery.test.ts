/**
 * restart-recovery.test.ts — gate 3 integration test (T44)
 *
 * Gate 3: Graceful restart recovery — strategy-layer state store survives
 * process restart. Specifically: FileStrategyStateStore round-trips state to
 * disk and can resume from it after re-instantiation.
 *
 * Interpretation (Option B):
 *   Gate 3 at the strategy layer verifies that FileStrategyStateStore persists
 *   data durably across two successive runtime instantiations within the same
 *   process (simulating a cold restart). The signal-source-level checkpoint
 *   test (GeyserSignalSource + FileSignalCheckpointStore) lives in the
 *   solana-signals package e2e tests and targets PRP-03 checkpoint recovery.
 *
 * Child-process SIGKILL on Windows:
 *   Windows does not support SIGKILL from Node's child_process.kill(). A true
 *   process-kill harness would require `tree-kill` or `taskkill /F /PID`. To
 *   avoid platform-specific complexity the test uses two sequential runtime
 *   instantiations in the same process — this exercises the exact same
 *   FileStrategyStateStore durability contract and is the idiomatic integration
 *   test for this layer.
 *
 * What is proven:
 *   1. State written by run-1 is visible to run-2 after the store is
 *      re-instantiated from the same directory.
 *   2. A strategy that checkpoints processed signalIds can skip already-seen
 *      signals on re-run — no dups, no gaps in the processed set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SignalQueue } from '@ap3x/solana-signals';
import type { Signal } from '@ap3x/solana-signals';

import { Strategy } from '../src/strategy.js';
import { StrategyRuntime } from '../src/runtime.js';
import { FileStrategyStateStore } from '../src/state-store-file.js';
import type { SignalFilter } from '../src/filter.js';
import type { StrategyContext } from '../src/context.js';
import {
  makeRuntimeOpts,
  makeSignal,
  FakeExecutor,
  FakePortfolio,
  makeFakeRpcPool,
  makeFakeResolveWallet,
} from './_helpers.js';

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let stateDir: string;

beforeAll(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `ap3x-restart-recovery-${process.pid}-${Date.now()}`,
  );
  stateDir = path.join(tmpDir, 'strategy-state');
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
// CheckpointingStrategy — stores processed signalIds to disk; on re-run,
// skips already-seen signals.
// ---------------------------------------------------------------------------

/**
 * Strategy that:
 *   1. On onStart, loads the existing processed-id set from state.
 *   2. On onSignal, skips signals whose id is in the set; otherwise records
 *      the id in `processed` and writes the updated set to state.
 *
 * This tests both the write path (run-1) and the read path (run-2).
 */
class CheckpointingStrategy extends Strategy {
  readonly name: string;
  readonly filters: SignalFilter[] = [{ kind: 'swap' }];

  /** Signals processed in THIS runtime instantiation (not persisted here). */
  readonly processedInRun: string[] = [];

  /** Loaded from state on onStart — signals already processed in a prior run. */
  private priorProcessed = new Set<string>();

  constructor(name: string) {
    super();
    this.name = name;
  }

  override async onStart(ctx: StrategyContext): Promise<void> {
    const stored = await ctx.state.get<string[]>('processed-ids');
    this.priorProcessed = new Set(stored ?? []);
  }

  async onSignal(sig: Signal, ctx: StrategyContext): Promise<null> {
    if (this.priorProcessed.has(sig.signalId)) {
      // Already processed in a prior run — skip
      return null;
    }
    this.processedInRun.push(sig.signalId);
    // Persist updated set to state
    const all = [...this.priorProcessed, ...this.processedInRun];
    await ctx.state.set('processed-ids', all);
    return null;
  }

  // onShutdown must be defined so that deregister() waits for all queued
  // onSignal tasks to complete before resolving (InstanceQueue serializes all
  // hooks; deregister awaits onShutdown only when the hook is defined).
  override async onShutdown(_ctx: StrategyContext): Promise<void> {
    // no-op — just needs to be defined so deregister() drains the queue
  }
}

// ---------------------------------------------------------------------------
// Helper — create a runtime that uses a real FileStrategyStateStore
// ---------------------------------------------------------------------------

function makeRuntimeWithFileStore(
  storeDir: string,
  strategyName: string,
  instanceId: string,
  _signals: Signal[],
): { runtime: StrategyRuntime; queue: SignalQueue; strategy: CheckpointingStrategy } {
  const executor = new FakeExecutor();
  const portfolio = new FakePortfolio();
  // dedupWindow:0 disables the LRU dedup so replaying the same signalIds
  // across two sequential runtime instantiations is not blocked by the cache.
  const queue = new SignalQueue({ dedupWindow: 0 });
  const stateStoreFactory = (_sn: string, _id: string) =>
    new FileStrategyStateStore({ dir: storeDir, strategyName, instanceId });

  const runtime = new StrategyRuntime({
    signalQueue: queue,
    executor,
    portfolio,
    resolveWallet: makeFakeResolveWallet(),
    rpcPool: makeFakeRpcPool() as unknown as import('../src/landed-trade-adapter.js').RpcPoolLike,
    stateStoreFactory,
    tickIntervalMs: 999_999,
  });

  const strategy = new CheckpointingStrategy(strategyName);
  return { runtime, queue, strategy };
}

async function pushAndDrain(queue: SignalQueue, signals: Signal[]): Promise<void> {
  for (const sig of signals) await queue.push(sig);
  // Drain the signal queue, then let per-instance queue tasks (including async
  // FileStrategyStateStore writes) settle. The instance queue is a microtask
  // chain so multiple setImmediate rounds are needed to flush all pending work.
  await queue.drain();
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((res) => setImmediate(res));
  }
}

// ---------------------------------------------------------------------------
// Gate 3 tests
// ---------------------------------------------------------------------------

describe('gate 3 — FileStrategyStateStore survives restart (strategy-layer checkpoint)', () => {
  it('state written in run-1 is readable in run-2 after re-instantiation', async () => {
    // Gate 3: verify FileStrategyStateStore round-trips durably.

    const store1 = new FileStrategyStateStore({
      dir: stateDir,
      strategyName: 'round-trip',
      instanceId: 'default',
    });
    await store1.set('foo', { value: 42 });

    // New instance pointing at the same directory
    const store2 = new FileStrategyStateStore({
      dir: stateDir,
      strategyName: 'round-trip',
      instanceId: 'default',
    });
    const result = await store2.get<{ value: number }>('foo');
    expect(result?.value).toBe(42);
  });

  it('run-1 processes 5 signals; run-2 skips them — no dups after restart', async () => {
    // Gate 3 end-to-end:
    //   run-1: process 5 signals, persist processed-ids to FileStrategyStateStore.
    //   run-2: same 5 signals replayed; strategy skips already-seen ids.
    //   result: processedInRun for run-2 is empty (all skipped).

    const signals: Signal[] = Array.from({ length: 5 }, (_, i) =>
      makeSignal('swap', `restart-sig-${i}`, 300 + i),
    );
    const strategyName = 'restart-test';
    const instanceId = 'inst-1';

    // Run 1: process all 5 signals
    {
      const { runtime, queue, strategy } = makeRuntimeWithFileStore(
        stateDir, strategyName, instanceId, signals,
      );
      await runtime.register(strategy, instanceId);
      runtime.start();
      await pushAndDrain(queue, signals);
      runtime.stop();
      await runtime.deregister(instanceId);

      expect(strategy.processedInRun).toHaveLength(5);
      expect(strategy.processedInRun).toEqual(signals.map((s) => s.signalId));
    }

    // Run 2: replay the same 5 signals — all should be skipped
    {
      const { runtime, queue, strategy } = makeRuntimeWithFileStore(
        stateDir, strategyName, instanceId, signals,
      );
      await runtime.register(strategy, instanceId);
      runtime.start();
      await pushAndDrain(queue, signals);
      runtime.stop();
      await runtime.deregister(instanceId);

      // No signals processed in run-2 (all were skipped)
      expect(strategy.processedInRun).toHaveLength(0);
    }
  });

  it('run-1 processes first 3; run-2 processes remaining 2 — no gaps', async () => {
    // Gate 3 partial processing:
    //   Simulates killing mid-run: run-1 processes only the first 3 signals.
    //   run-2 starts fresh; the strategy skips the first 3 and processes 4+5.

    const signals: Signal[] = Array.from({ length: 5 }, (_, i) =>
      makeSignal('swap', `partial-sig-${i}`, 400 + i),
    );
    const strategyName = 'partial-restart';
    const instanceId = 'inst-2';

    // Run 1: process only the first 3 signals
    {
      const { runtime, queue, strategy } = makeRuntimeWithFileStore(
        stateDir, strategyName, instanceId, signals,
      );
      await runtime.register(strategy, instanceId);
      runtime.start();
      await pushAndDrain(queue, signals.slice(0, 3));
      runtime.stop();
      await runtime.deregister(instanceId);

      expect(strategy.processedInRun).toHaveLength(3);
    }

    // Run 2: replay all 5 — should skip first 3, process signals 4+5
    {
      const { runtime, queue, strategy } = makeRuntimeWithFileStore(
        stateDir, strategyName, instanceId, signals,
      );
      await runtime.register(strategy, instanceId);
      runtime.start();
      await pushAndDrain(queue, signals);
      runtime.stop();
      await runtime.deregister(instanceId);

      expect(strategy.processedInRun).toHaveLength(2);
      expect(strategy.processedInRun).toEqual([
        signals[3]!.signalId,
        signals[4]!.signalId,
      ]);
    }
  });

  it('list() and delete() round-trip on FileStrategyStateStore', async () => {
    // Structural: verify full CRUD surface of the state store.
    const store = new FileStrategyStateStore({
      dir: stateDir,
      strategyName: 'crud-test',
      instanceId: 'default',
    });

    await store.set('alpha', 1);
    await store.set('beta', 2);
    await store.set('gamma', 3);

    const keys = await store.list();
    expect(keys).toContain('alpha');
    expect(keys).toContain('beta');
    expect(keys).toContain('gamma');

    await store.delete('beta');
    const keysAfter = await store.list();
    expect(keysAfter).not.toContain('beta');
    expect(keysAfter).toContain('alpha');

    // Prefix filter
    await store.set('alpha-2', 99);
    const alphaKeys = await store.list('alpha');
    expect(alphaKeys.every((k) => k.startsWith('alpha'))).toBe(true);
  });
});
