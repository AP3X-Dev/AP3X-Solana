/**
 * lifecycle-fidelity.test.ts — gate 10 (expanded) integration test (T44)
 *
 * Gate 10 expanded: verify every hook fires in spec'd order, error propagation
 * is isolated, per-instance serialization holds under concurrent dispatch, and
 * the onBalanceChange hook can be defined without breaking the runtime.
 *
 * Tests:
 *   3a: Register → push signals → trigger execution result → trigger position
 *       change → deregister. Assert hook phase sequence.
 *   3b: Strategy's onSignal throws → onError fires, runtime emits 'strategy-error'.
 *   3c: Concurrent dispatch serializes per instance (signal + tick interleave-free).
 *   3d: onBalanceChange defined but not wired — runtime does not crash.
 */

import { describe, it, expect } from 'vitest';

import type { Signal } from '@ap3x/solana-signals';
import type { ExecutionResult } from '@ap3x/solana-executor';
import type { PositionChange } from '@ap3x/solana-portfolio';
import { PublicKey } from '@ap3x/solana-core';

import { Strategy } from '../src/strategy.js';
import { StrategyRuntime } from '../src/runtime.js';
import type { SignalFilter } from '../src/filter.js';
import type { StrategyContext } from '../src/context.js';
import type { HookPhase, BalanceDelta } from '../src/strategy.js';
import { makeRuntimeOpts, makeSignal, drainQueue, SYSTEM_PROGRAM } from './_helpers.js';

// ---------------------------------------------------------------------------
// All-hooks strategy — logs every hook invocation as { phase, tsMs }
// ---------------------------------------------------------------------------

interface HookEvent {
  phase: string;
  tsMs: number;
}

class AllHooksStrategy extends Strategy {
  readonly name: string;
  readonly filters: SignalFilter[];
  readonly log: HookEvent[] = [];

  constructor(name: string, filters: SignalFilter[]) {
    super();
    this.name = name;
    this.filters = filters;
  }

  private record(phase: string): void {
    this.log.push({ phase, tsMs: Date.now() });
  }

  override async onStart(_ctx: StrategyContext): Promise<void> {
    this.record('onStart');
  }

  async onSignal(_sig: Signal, _ctx: StrategyContext): Promise<null> {
    this.record('onSignal');
    return null;
  }

  override async onExecutionResult(_result: ExecutionResult, _ctx: StrategyContext): Promise<void> {
    this.record('onExecutionResult');
  }

  override async onPositionChange(_change: PositionChange, _ctx: StrategyContext): Promise<void> {
    this.record('onPositionChange');
  }

  override async onTick(_tsMs: number, _ctx: StrategyContext): Promise<void> {
    this.record('onTick');
  }

  override async onShutdown(_ctx: StrategyContext): Promise<void> {
    this.record('onShutdown');
  }

  override onError(_err: Error, _phase: HookPhase, _ctx: StrategyContext): void {
    this.record('onError');
  }

  // onBalanceChange is defined but the runtime does not wire it (deferred to PRP-03)
  override async onBalanceChange(
    _wallet: string,
    _deltas: BalanceDelta[],
    _ctx: StrategyContext,
  ): Promise<void> {
    this.record('onBalanceChange');
  }
}

// ---------------------------------------------------------------------------
// Test 3a — hook phase sequence: register → signal → execResult → posChange → deregister
// ---------------------------------------------------------------------------

describe('gate 10 — test 3a: hook phase sequence', () => {
  it('onStart fires at register; onSignal on signal; onExecutionResult on executor result; onPositionChange on portfolio change; onShutdown on deregister', async () => {
    const { opts, executor, portfolio } = makeRuntimeOpts({ tickIntervalMs: 999_999 });
    const runtime = new StrategyRuntime(opts);
    const strategy = new AllHooksStrategy('all-hooks', [{ kind: 'swap' }]);

    // register — triggers onStart
    await runtime.register(strategy);
    runtime.start();

    // push a signal — triggers onSignal
    await opts.signalQueue.push(makeSignal('swap', 'ah-sig-1'));
    await drainQueue(opts.signalQueue);

    // fire executor 'result' event — triggers onExecutionResult
    const fakeResult: ExecutionResult = {
      kind: 'timeout',
      intentId: 'x',
      signature: 'sig',
      submitterUsed: 'rpc',
    };
    executor.emit('result', fakeResult);
    await new Promise<void>((res) => setImmediate(res));

    // fire portfolio 'change' event — triggers onPositionChange
    const fakeChange: PositionChange = {
      wallet: PublicKey.fromBase58(SYSTEM_PROGRAM),
      mint: PublicKey.fromBase58(SYSTEM_PROGRAM),
      before: null,
      after: {
        mint: PublicKey.fromBase58(SYSTEM_PROGRAM),
        walletAddress: PublicKey.fromBase58(SYSTEM_PROGRAM),
        lots: [],
        lastUpdatedSlot: 100,
      },
      reason: 'apply-landed-trade',
    };
    portfolio.emit('change', fakeChange);
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    // deregister — triggers onShutdown
    await runtime.deregister('all-hooks');
    runtime.stop();

    const phases = strategy.log.map((e) => e.phase);

    // onStart must be first
    expect(phases[0]).toBe('onStart');
    // onSignal must appear
    expect(phases).toContain('onSignal');
    // onExecutionResult must appear after onSignal
    expect(phases).toContain('onExecutionResult');
    expect(phases.indexOf('onExecutionResult')).toBeGreaterThan(phases.indexOf('onSignal'));
    // onPositionChange must appear
    expect(phases).toContain('onPositionChange');
    // onShutdown must be last
    expect(phases[phases.length - 1]).toBe('onShutdown');
  });
});

// ---------------------------------------------------------------------------
// Test 3b — onSignal throws → onError fires + runtime emits 'strategy-error'
// ---------------------------------------------------------------------------

describe('gate 10 — test 3b: onSignal error propagation', () => {
  it('onSignal throw → onError called synchronously; runtime emits strategy-error', async () => {
    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);

    const onErrorCalls: Array<{ err: Error; phase: string }> = [];
    const runtimeErrors: Array<{ instanceId: string; phase: string }> = [];
    runtime.on('strategy-error', (evt) => runtimeErrors.push(evt));

    class ThrowingHooksStrategy extends Strategy {
      readonly name = 'throwing-hooks';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];

      async onSignal(): Promise<null> {
        throw new Error('signal-kaboom');
      }

      override onError(err: Error, phase: HookPhase): void {
        onErrorCalls.push({ err, phase });
      }
    }

    await runtime.register(new ThrowingHooksStrategy());
    runtime.start();

    await opts.signalQueue.push(makeSignal('swap', '3b-sig-1'));
    await drainQueue(opts.signalQueue);
    runtime.stop();

    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]!.err.message).toBe('signal-kaboom');
    expect(onErrorCalls[0]!.phase).toBe('onSignal');

    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]!.phase).toBe('onSignal');
    expect(runtimeErrors[0]!.instanceId).toBe('throwing-hooks');
  });

  it('onError that throws itself does NOT propagate — error is swallowed', async () => {
    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);

    class DoubleThrowStrategy extends Strategy {
      readonly name = 'double-throw-lifecycle';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(): Promise<null> { throw new Error('hook-err'); }
      override onError(): void { throw new Error('reporter-err'); }
    }

    await runtime.register(new DoubleThrowStrategy());
    runtime.start();

    // Must not throw/reject
    await expect(opts.signalQueue.push(makeSignal('swap', '3b-dt-1'))).resolves.toBeUndefined();
    await drainQueue(opts.signalQueue);
    runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 3c — per-instance serialization under concurrent signal + tick
// ---------------------------------------------------------------------------

describe('gate 10 — test 3c: per-instance serialization under concurrent dispatch', () => {
  it('signal and tick for the same instance do not interleave', async () => {
    // Control: signal callback blocks on a gate; tick must wait.
    let resolveSignal!: () => void;
    const signalGate = new Promise<void>((r) => { resolveSignal = r; });

    const eventLog: string[] = [];

    class SerializedStrategy extends Strategy {
      readonly name = 'serialized';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];

      async onSignal(_sig: Signal): Promise<null> {
        eventLog.push('signal-start');
        await signalGate;
        eventLog.push('signal-end');
        return null;
      }

      override async onTick(): Promise<void> {
        eventLog.push('tick');
      }
    }

    // Fast tick interval to race the signal callback
    const { opts } = makeRuntimeOpts({ tickIntervalMs: 20 });
    const runtime = new StrategyRuntime(opts);
    await runtime.register(new SerializedStrategy());
    runtime.start();

    // Push a signal — it will block on signalGate
    void opts.signalQueue.push(makeSignal('swap', '3c-sig'));
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    // The signal should have started but not finished
    expect(eventLog).toContain('signal-start');
    expect(eventLog).not.toContain('signal-end');

    // Wait long enough for tick to try to fire (but it must wait for the queue)
    await new Promise<void>((res) => setTimeout(res, 60));

    // Tick should NOT appear before signal-end (serialized per instance)
    const signalEndIdx = eventLog.indexOf('signal-end');
    // signal-end hasn't happened yet — unblock
    resolveSignal();
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setTimeout(res, 40));

    runtime.stop();
    await drainQueue(opts.signalQueue);

    const finalSignalEndIdx = eventLog.indexOf('signal-end');
    expect(finalSignalEndIdx).toBeGreaterThan(-1);

    // Any ticks that fired must come after signal-end in the log
    const tickIndices = eventLog
      .map((e, i) => (e === 'tick' ? i : -1))
      .filter((i) => i >= 0);

    for (const ti of tickIndices) {
      expect(ti).toBeGreaterThan(finalSignalEndIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3d — onBalanceChange defined without crashing the runtime
// ---------------------------------------------------------------------------

describe('gate 10 — test 3d: onBalanceChange does not crash runtime', () => {
  it('strategy with onBalanceChange defined: register, push signals, deregister — no crash', async () => {
    // onBalanceChange is not currently wired to any event in the runtime
    // (deferred to PRP-03 when balance subscription is added). Defining the
    // hook must not break registration, dispatch, or deregistration.

    const { opts } = makeRuntimeOpts();
    const runtime = new StrategyRuntime(opts);
    const strategy = new AllHooksStrategy('balance-change-test', [{ kind: 'swap' }]);

    await runtime.register(strategy);
    runtime.start();

    await opts.signalQueue.push(makeSignal('swap', '3d-sig-1'));
    await opts.signalQueue.push(makeSignal('swap', '3d-sig-2'));
    await drainQueue(opts.signalQueue);

    await runtime.deregister('balance-change-test');
    runtime.stop();

    // onBalanceChange was NOT called (not wired)
    const balanceChangeCalls = strategy.log.filter((e) => e.phase === 'onBalanceChange');
    expect(balanceChangeCalls).toHaveLength(0);

    // onSignal WAS called
    const signalCalls = strategy.log.filter((e) => e.phase === 'onSignal');
    expect(signalCalls).toHaveLength(2);

    // onShutdown fired on deregister
    const shutdownCalls = strategy.log.filter((e) => e.phase === 'onShutdown');
    expect(shutdownCalls).toHaveLength(1);
  });
});
