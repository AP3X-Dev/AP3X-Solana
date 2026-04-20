/**
 * e2e-fixture.test.ts — gates 1, 2, 10 integration tests (T44)
 *
 * Gate 1: Signal ingestion end-to-end — every subscribed signal fires onSignal,
 *         no drops, no dups.
 * Gate 2: Dispatch ordering — FIFO per instance (signals arrive in fixture order).
 * Gate 10: Graceful shutdown via runtime.stop() — no ticks after stop, no
 *          onSignal fires after stop.
 *
 * Wiring: FixtureSignalSource → SignalQueue → StrategyRuntime → FakeExecutor
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { FixtureSignalSource } from '@ap3x/solana-signals';
import { SignalQueue } from '@ap3x/solana-signals';
import type { Signal } from '@ap3x/solana-signals';

import { Strategy } from '../src/strategy.js';
import { StrategyRuntime } from '../src/runtime.js';
import type { SignalFilter } from '../src/filter.js';
import type { StrategyContext } from '../src/context.js';
import {
  makeRuntimeOpts,
  makeSignal,
  writeFixtureGzip,
  drainQueue,
  MemStateStore,
} from './_helpers.js';

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
  tmpDir = path.join(
    os.tmpdir(),
    `ap3x-e2e-fixture-${process.pid}-${Date.now()}`,
  );
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Fixture: 12 signals — 10 'swap' + 2 'mint'. Strategy subscribes only to 'swap'.
// ---------------------------------------------------------------------------

const FIXTURE_SIGNALS: Signal[] = Array.from({ length: 12 }, (_, i) =>
  makeSignal(i % 6 === 0 ? 'mint' : 'swap', `fix-sig-${i}`, 100 + i),
);
// Indices 0 and 6 are 'mint'; the other 10 are 'swap'.
const SWAP_SIGNAL_IDS = FIXTURE_SIGNALS
  .filter((s) => s.kind === 'swap')
  .map((s) => s.signalId);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strategy that records signalIds in arrival order. */
class RecordingStrategy extends Strategy {
  readonly name: string;
  readonly filters: SignalFilter[];
  readonly received: string[] = [];

  constructor(name: string, filters: SignalFilter[]) {
    super();
    this.name = name;
    this.filters = filters;
  }

  async onSignal(sig: Signal, _ctx: StrategyContext) {
    this.received.push(sig.signalId);
    return null;
  }
}

/** Run the fixture source through the queue, resolving when 'end' fires. */
async function runFixture(fixturePath: string, queue: SignalQueue): Promise<void> {
  const source = new FixtureSignalSource({ path: fixturePath });
  source.on('signal', (sig: Signal) => { void queue.push(sig); });
  await new Promise<void>((resolve, reject) => {
    source.once('end', resolve);
    source.once('error', reject);
    void source.start();
  });
}

// ---------------------------------------------------------------------------
// Gate 1 — Signal ingestion end-to-end
// ---------------------------------------------------------------------------

describe('gate 1 — signal ingestion end-to-end', () => {
  it('strategy sees every matching signal — no drops, no dups; count == input count', async () => {
    const fixturePath = writeFixtureGzip(FIXTURE_SIGNALS, 'gate1.jsonl.gz');
    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new RecordingStrategy('gate1-strat', [{ kind: 'swap' }]);

    await runtime.register(strategy);
    runtime.start();

    await runFixture(fixturePath, opts.signalQueue);
    await drainQueue(opts.signalQueue);
    runtime.stop();

    // Every 'swap' signal must arrive exactly once
    expect(strategy.received).toHaveLength(SWAP_SIGNAL_IDS.length);
    expect(new Set(strategy.received).size).toBe(SWAP_SIGNAL_IDS.length); // no dups

    for (const id of SWAP_SIGNAL_IDS) {
      expect(strategy.received).toContain(id);
    }
  });

  it('strategy with empty filters receives NO signals (matches nothing)', async () => {
    const fixturePath = writeFixtureGzip(FIXTURE_SIGNALS, 'gate1-empty.jsonl.gz');
    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new RecordingStrategy('gate1-empty', []); // no filters

    await runtime.register(strategy);
    runtime.start();

    await runFixture(fixturePath, opts.signalQueue);
    await drainQueue(opts.signalQueue);
    runtime.stop();

    expect(strategy.received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — Dispatch ordering (FIFO per instance)
// ---------------------------------------------------------------------------

describe('gate 2 — dispatch ordering FIFO per instance', () => {
  it('signals arrive in fixture order — signalId array matches fixture order', async () => {
    const fixturePath = writeFixtureGzip(FIXTURE_SIGNALS, 'gate2.jsonl.gz');
    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new RecordingStrategy('gate2-strat', [{ kind: 'swap' }]);

    await runtime.register(strategy);
    runtime.start();

    await runFixture(fixturePath, opts.signalQueue);
    await drainQueue(opts.signalQueue);
    runtime.stop();

    // Received order must match the fixture order exactly
    expect(strategy.received).toEqual(SWAP_SIGNAL_IDS);
  });

  it('two instances each see signals in fixture order independently', async () => {
    const fixturePath = writeFixtureGzip(FIXTURE_SIGNALS, 'gate2-two.jsonl.gz');
    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const stratA = new RecordingStrategy('gate2-A', [{ kind: 'swap' }]);
    const stratB = new RecordingStrategy('gate2-B', [{ kind: 'swap' }]);

    await runtime.register(stratA);
    await runtime.register(stratB);
    runtime.start();

    await runFixture(fixturePath, opts.signalQueue);
    await drainQueue(opts.signalQueue);
    runtime.stop();

    expect(stratA.received).toEqual(SWAP_SIGNAL_IDS);
    expect(stratB.received).toEqual(SWAP_SIGNAL_IDS);
  });
});

// ---------------------------------------------------------------------------
// Gate 10 — Graceful shutdown
// ---------------------------------------------------------------------------

describe('gate 10 — graceful shutdown via stop()', () => {
  it('no onSignal fires after runtime.stop()', async () => {
    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new RecordingStrategy('gate10-stop', [{ kind: 'swap' }]);

    await runtime.register(strategy);
    runtime.start();

    // Push a few signals before stop
    await opts.signalQueue.push(makeSignal('swap', 'pre-stop-1'));
    await opts.signalQueue.push(makeSignal('swap', 'pre-stop-2'));
    await drainQueue(opts.signalQueue);

    const countAtStop = strategy.received.length;
    runtime.stop();

    // Push signals after stop — should not reach onSignal
    await opts.signalQueue.push(makeSignal('swap', 'post-stop-1'));
    await opts.signalQueue.push(makeSignal('swap', 'post-stop-2'));
    await drainQueue(opts.signalQueue);

    expect(strategy.received.length).toBe(countAtStop);
    expect(strategy.received).not.toContain('post-stop-1');
    expect(strategy.received).not.toContain('post-stop-2');
  });

  it('no onTick fires after stop() — tick count frozen after clearInterval', async () => {
    // Gate 10: tick interval stops
    const tickCalls: number[] = [];
    class TickStrategy extends Strategy {
      readonly name = 'gate10-tick';
      readonly filters: SignalFilter[] = [];
      async onSignal() { return null; }
      override async onTick(tsMs: number) { tickCalls.push(tsMs); }
    }

    const { opts } = makeRuntimeOpts({ tickIntervalMs: 40 });
    const runtime = new StrategyRuntime(opts);
    await runtime.register(new TickStrategy());
    runtime.start();

    // Wait for at least two ticks
    await new Promise<void>((res) => setTimeout(res, 100));
    expect(tickCalls.length).toBeGreaterThan(0);

    const countAtStop = tickCalls.length;
    runtime.stop();

    // Wait past one more tick interval — no new ticks should fire
    await new Promise<void>((res) => setTimeout(res, 80));
    expect(tickCalls.length).toBe(countAtStop);
  });

  it('onShutdown fires during deregister after stop', async () => {
    // Gate 10: graceful deregistration path
    const shutdownLog: string[] = [];
    class ShutdownStrategy extends Strategy {
      readonly name = 'gate10-shutdown';
      readonly filters: SignalFilter[] = [];
      async onSignal() { return null; }
      override async onShutdown() { shutdownLog.push('shutdown'); }
    }

    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    await runtime.register(new ShutdownStrategy());
    runtime.start();
    runtime.stop();

    await runtime.deregister('gate10-shutdown');
    expect(shutdownLog).toEqual(['shutdown']);
  });

  it('signal queue subscriber is removed after stop — queue.unsubscribe called', async () => {
    // Verify via indirect test: after stop, pushing to queue emits no 'handler-error'
    // and no signals reach the strategy.
    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new RecordingStrategy('gate10-unsub', [{ kind: 'swap' }]);

    await runtime.register(strategy);
    runtime.start();
    runtime.stop();

    const handlerErrors: unknown[] = [];
    opts.signalQueue.on('handler-error', (e) => handlerErrors.push(e));

    await opts.signalQueue.push(makeSignal('swap', 'after-stop'));
    await drainQueue(opts.signalQueue);

    expect(strategy.received).toHaveLength(0);
    expect(handlerErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gate 1 + 2 combined — fixture source wires correctly into the full pipeline
// ---------------------------------------------------------------------------

describe('gate 1+2 combined — FixtureSignalSource → StrategyRuntime full pipeline', () => {
  it('all matching signals processed in order with no extra allocations', async () => {
    const signals = [
      makeSignal('swap', 'combined-1', 200),
      makeSignal('mint', 'combined-2', 201),
      makeSignal('swap', 'combined-3', 202),
      makeSignal('swap', 'combined-4', 203),
      makeSignal('mint', 'combined-5', 204),
    ];
    const fixturePath = writeFixtureGzip(signals, 'gate12-combined.jsonl.gz');
    const { opts } = makeRuntimeOpts({ stateStoreFactory: () => new MemStateStore() });
    const runtime = new StrategyRuntime(opts);
    const strategy = new RecordingStrategy('combined', [{ kind: 'swap' }]);

    await runtime.register(strategy);
    runtime.start();

    await runFixture(fixturePath, opts.signalQueue);
    await drainQueue(opts.signalQueue);
    runtime.stop();

    // Only swap signals
    expect(strategy.received).toEqual(['combined-1', 'combined-3', 'combined-4']);
  });
});
