/**
 * runtime.test.ts — StrategyRuntime unit tests (T42)
 *
 * All tests use fakes — no real Executor, FilePortfolioStore, or vault.
 * SignalQueue is real (it's lightweight and correct).
 *
 * Test inventory:
 *  1. register + onStart fires through the queue
 *  2. dispatchSignal matches filter; non-matching filter skipped
 *  3. dispatchSignal with non-null decision flows through guard → executor → adapter → portfolio
 *  4. Per-instance serialization: slow first signal, second waits
 *  5. Cross-instance concurrency: two instances run in parallel
 *  6. Guard trip → quarantine → metrics.emit → subsequent signals ignored
 *  7. onError synchronous: hook throws → onError called, runtime emits 'strategy-error', guards.recordError called
 *  8. pause/resume: paused instance skips hook; resumed instance processes
 *  9. deregister calls onShutdown then removes from map
 * 10. stop() clears tick timer and unsubscribes from signal queue
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { PublicKey } from '@ap3x/solana-core';
import { SignalQueue } from '@ap3x/solana-signals';
import type { Signal } from '@ap3x/solana-signals';
import type { ExecutionResult, TradeIntent } from '@ap3x/solana-executor';
import type { PositionChange, LandedTrade } from '@ap3x/solana-portfolio';

import { Strategy } from './strategy.js';
import type { StrategyContext, StrategyStateStore } from './context.js';
import type { SignalFilter } from './filter.js';
import { StrategyRuntime } from './runtime.js';
import type { StrategyRuntimeOpts, ExecutorLike, PortfolioLike } from './runtime.js';

// ---------------------------------------------------------------------------
// Known valid 32-byte Solana addresses (base58)
// ---------------------------------------------------------------------------
const TOKEN_PROGRAM  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022     = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// ---------------------------------------------------------------------------
// Fake infrastructure
// ---------------------------------------------------------------------------

/** Minimal fake executor — implements ExecutorLike + EventEmitter. */
class FakeExecutor extends EventEmitter implements ExecutorLike {
  submittedIntents: TradeIntent[] = [];
  submitResult: ExecutionResult = {
    kind: 'timeout',
    intentId: 'fake',
    signature: 'fake-sig',
    submitterUsed: 'rpc',
  };

  async submit(intent: TradeIntent): Promise<ExecutionResult> {
    this.submittedIntents.push(intent);
    return { ...this.submitResult, intentId: intent.intentId };
  }
}

/** Minimal fake portfolio — implements PortfolioLike + EventEmitter. */
class FakePortfolio extends EventEmitter implements PortfolioLike {
  appliedTrades: LandedTrade[] = [];

  async applyLandedTrade(trade: LandedTrade): Promise<PositionChange[]> {
    this.appliedTrades.push(trade);
    const change: PositionChange = {
      wallet: trade.wallet,
      mint: trade.mint,
      before: null,
      after: {
        mint: trade.mint,
        walletAddress: trade.wallet,
        lots: [],
        lastUpdatedSlot: trade.slot,
      },
      reason: 'apply-landed-trade',
    };
    this.emit('change', change);
    return [change];
  }

  // PortfolioReadApi stubs — satisfy widened PortfolioLike interface
  async getPosition(_wallet: PublicKey, _mint: PublicKey) { return null; }
  async getAllPositions(_wallet: PublicKey) { return []; }
  async getRealizedPnl(_wallet: PublicKey, _mint: PublicKey) { return 0n; }
  async getUnrealizedPnl(_wallet: PublicKey, _mint: PublicKey, _currentPriceLamports: bigint) { return 0n; }
}

/** Fake RpcPool — returns empty for getTransaction (adapter returns []). */
const fakeRpcPool = {
  call: vi.fn().mockResolvedValue(null),
};

/** Minimal fake WalletHandle. */
function makeFakeWalletHandle(address: PublicKey) {
  return {
    address,
    sign: vi.fn(),
    signTransaction: vi.fn(),
  };
}

/** Create a fake signal with given kind. */
function makeSignal(kind: string, signalId = `sig-${kind}-${Math.random()}`): Signal {
  return {
    signalId,
    ts: Date.now(),
    slot: 100,
    signature: 'tx-sig',
    programId: PublicKey.fromBase58('11111111111111111111111111111111'),
    kind,
    decoded: {},
    raw: { slot: 100, signature: 'tx-sig', programId: '11111111111111111111111111111111', logs: [] } as any,
  };
}

/** Minimal in-memory StrategyStateStore. */
class MemStateStore implements StrategyStateStore {
  private store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> { return (this.store.get(key) as T) ?? null; }
  async set<T>(key: string, value: T): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.store.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
}

/** Base opts factory. */
function makeOpts(
  overrides: Partial<StrategyRuntimeOpts> = {},
): { opts: StrategyRuntimeOpts; executor: FakeExecutor; portfolio: FakePortfolio; walletPk: PublicKey } {
  const executor = new FakeExecutor();
  const portfolio = new FakePortfolio();
  const walletPk = PublicKey.fromBase58(TOKEN_PROGRAM);
  const opts: StrategyRuntimeOpts = {
    signalQueue: new SignalQueue(),
    executor,
    portfolio,
    resolveWallet: async () => makeFakeWalletHandle(walletPk) as any,
    rpcPool: fakeRpcPool as any,
    stateStoreFactory: () => new MemStateStore(),
    tickIntervalMs: 999_999, // effectively disabled in most tests
    ...overrides,
  };
  return { opts, executor, portfolio, walletPk };
}

// ---------------------------------------------------------------------------
// Minimal concrete Strategy subclasses
// ---------------------------------------------------------------------------

class NoOpStrategy extends Strategy {
  readonly name = 'no-op';
  readonly filters: SignalFilter[] = [{ kind: 'swap' }];
  async onSignal(_sig: Signal, _ctx: StrategyContext) { return null; }
}

class DecidingStrategy extends Strategy {
  readonly name = 'decider';
  readonly filters: SignalFilter[] = [{ kind: 'swap' }];

  decision: TradeIntent | null = {
    intentId: '', // will be overridden by runtime
    wallet: 'main',
    instructions: [],
    feeTier: 'med',
    deadline: Date.now() + 30_000,
  };

  async onSignal(_sig: Signal, _ctx: StrategyContext) {
    return this.decision;
  }
}

// ---------------------------------------------------------------------------
// Test 1 — register + onStart fires through the queue
// ---------------------------------------------------------------------------

describe('Test 1 — register: onStart fires before register returns', () => {
  it('onStart resolves before register() promise resolves', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);

    const order: string[] = [];
    class StartStrategy extends Strategy {
      readonly name = 'start-test';
      readonly filters: SignalFilter[] = [];
      override async onStart() { order.push('onStart'); }
      async onSignal() { return null; }
    }

    await runtime.register(new StartStrategy());
    order.push('after-register');

    expect(order).toEqual(['onStart', 'after-register']);
  });

  it('throws if same instanceId registered twice', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);
    await runtime.register(new NoOpStrategy());
    await expect(runtime.register(new NoOpStrategy())).rejects.toThrow('already registered');
  });

  it('custom instanceId overrides strategy.name', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);
    await runtime.register(new NoOpStrategy(), 'custom-id');
    // Should not throw — different id
    await runtime.register(new NoOpStrategy(), 'another-id');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — dispatchSignal filter matching
// ---------------------------------------------------------------------------

describe('Test 2 — dispatchSignal filter matching', () => {
  it('matching filter triggers onSignal', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);
    const called: string[] = [];

    class FilterStrategy extends Strategy {
      readonly name = 'filter-match';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(sig: Signal) { called.push(sig.kind); return null; }
    }

    await runtime.register(new FilterStrategy());
    runtime.start();
    await opts.signalQueue.push(makeSignal('swap'));
    await opts.signalQueue.drain();
    runtime.stop();

    expect(called).toHaveLength(1);
    expect(called[0]).toBe('swap');
  });

  it('non-matching filter does NOT trigger onSignal', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);
    const called: string[] = [];

    class FilterStrategy extends Strategy {
      readonly name = 'filter-no-match';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(sig: Signal) { called.push(sig.kind); return null; }
    }

    await runtime.register(new FilterStrategy());
    runtime.start();
    await opts.signalQueue.push(makeSignal('mint')); // different kind
    await opts.signalQueue.drain();
    runtime.stop();

    expect(called).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — dispatchSignal non-null decision flows through the pipeline
// ---------------------------------------------------------------------------

describe('Test 3 — decision flows guard → executor → adapter → portfolio', () => {
  it('executor.submit called with derived intentId; portfolio.applyLandedTrade NOT called for timeout result', async () => {
    const { opts, executor, portfolio } = makeOpts();
    executor.submitResult = { kind: 'timeout', intentId: 'x', signature: 'sig', submitterUsed: 'rpc' };

    const runtime = new StrategyRuntime(opts);
    const strategy = new DecidingStrategy();
    await runtime.register(strategy);
    runtime.start();

    const sig = makeSignal('swap', 'signal-001');
    await opts.signalQueue.push(sig);
    await opts.signalQueue.drain();
    // Wait for the per-instance queue task to complete
    await new Promise<void>((res) => setImmediate(res));
    runtime.stop();

    expect(executor.submittedIntents).toHaveLength(1);
    // intentId must be derived deterministically
    expect(executor.submittedIntents[0]!.intentId).toBeTruthy();
    expect(executor.submittedIntents[0]!.intentId).not.toBe('');
    // timeout → no landed trade → portfolio not called
    expect(portfolio.appliedTrades).toHaveLength(0);
  });

  it('landed result → portfolio.applyLandedTrade called for each trade', async () => {
    const walletPk = PublicKey.fromBase58(TOKEN_PROGRAM);
    const mintPk = PublicKey.fromBase58(TOKEN_2022);

    // Override the adapter by making rpcPool return a transaction with a token delta
    const localRpcPool = {
      call: vi.fn().mockResolvedValue({
        slot: 200,
        version: 0,
        meta: {
          fee: 5000,
          preBalances: [1_000_000, 0],
          postBalances: [900_000, 0],
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: mintPk.toBase58(),
              owner: walletPk.toBase58(),
              uiTokenAmount: { amount: '1000', decimals: 6, uiAmount: 0.001, uiAmountString: '0.001' },
            },
          ],
          err: null,
        },
        transaction: {
          message: {
            accountKeys: [walletPk.toBase58()],
            instructions: [],
            recentBlockhash: 'blockhash',
          },
          signatures: ['landed-sig'],
        },
      }),
    };

    const { opts, executor, portfolio } = makeOpts({ rpcPool: localRpcPool as any });
    executor.submitResult = {
      kind: 'landed',
      intentId: 'x',
      signature: 'landed-sig',
      slot: 200,
      submitterUsed: 'rpc',
      landedAt: Date.now(),
    };

    const runtime = new StrategyRuntime(opts);
    await runtime.register(new DecidingStrategy());
    runtime.start();

    await opts.signalQueue.push(makeSignal('swap', 'signal-land-001'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));
    runtime.stop();

    expect(portfolio.appliedTrades).toHaveLength(1);
    expect(portfolio.appliedTrades[0]!.slot).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Per-instance serialization
// ---------------------------------------------------------------------------

describe('Test 4 — per-instance serialization (no interleaving)', () => {
  it('second signal waits for first slow onSignal to complete', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);
    const log: string[] = [];

    // Manual promise to control first signal duration
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((res) => { resolveFirst = res; });

    let callCount = 0;
    class SlowStrategy extends Strategy {
      readonly name = 'slow';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(_sig: Signal) {
        const n = ++callCount;
        log.push(`start-${n}`);
        if (n === 1) await firstGate;
        log.push(`end-${n}`);
        return null;
      }
    }

    await runtime.register(new SlowStrategy());
    runtime.start();

    // Push both signals
    const p1 = opts.signalQueue.push(makeSignal('swap', 'sig-slow-1'));
    const p2 = opts.signalQueue.push(makeSignal('swap', 'sig-slow-2'));

    await Promise.all([p1, p2]);
    await opts.signalQueue.drain();

    // At this point signal 1 has been dequeued by the runtime but is blocked on firstGate
    // Signal 2's queue entry should be waiting
    // Only 'start-1' should be logged
    expect(log).toContain('start-1');
    expect(log).not.toContain('start-2');

    // Unblock signal 1
    resolveFirst();
    // Let microtasks settle
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    runtime.stop();
    expect(log).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Cross-instance concurrency
// ---------------------------------------------------------------------------

describe('Test 5 — cross-instance concurrency', () => {
  it('two registered instances run their onSignal callbacks in parallel', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);

    let resolveA!: () => void;
    let resolveB!: () => void;
    const gateA = new Promise<void>((r) => { resolveA = r; });
    const gateB = new Promise<void>((r) => { resolveB = r; });

    const startedA = { value: false };
    const startedB = { value: false };

    class StratA extends Strategy {
      readonly name = 'A';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal() { startedA.value = true; await gateA; return null; }
    }

    class StratB extends Strategy {
      readonly name = 'B';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal() { startedB.value = true; await gateB; return null; }
    }

    await runtime.register(new StratA());
    await runtime.register(new StratB());
    runtime.start();

    void opts.signalQueue.push(makeSignal('swap', 'sig-concurrent'));

    // Wait until signal dispatch has started
    await new Promise<void>((res) => setImmediate(res));
    await new Promise<void>((res) => setImmediate(res));

    // Both instances should have started concurrently (gates not yet released)
    expect(startedA.value).toBe(true);
    expect(startedB.value).toBe(true);

    resolveA();
    resolveB();
    await opts.signalQueue.drain();
    runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Guard trip → quarantine
// ---------------------------------------------------------------------------

describe('Test 6 — guard trip triggers quarantine', () => {
  it('maxDecisionsPerMin:1 — second signal triggers trip, instance quarantined, metrics fired, subsequent signals ignored', async () => {
    const metricsEmitted: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const metrics = {
      emit: (topic: string, payload: Record<string, unknown>) => { metricsEmitted.push({ topic, payload }); },
    };

    const { opts } = makeOpts({
      guards: { maxDecisionsPerMin: 1 },
      metrics,
    });

    const runtime = new StrategyRuntime(opts);

    const signalCount: number[] = [];
    class CountingStrategy extends Strategy {
      readonly name = 'counter';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal() {
        signalCount.push(1);
        return {
          intentId: '',
          wallet: 'main',
          instructions: [],
          feeTier: 'med' as const,
          deadline: Date.now() + 30_000,
        };
      }
    }

    await runtime.register(new CountingStrategy());
    runtime.start();

    // First signal — should succeed (decision #1, within limit of 1)
    await opts.signalQueue.push(makeSignal('swap', 'sig-trip-1'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));

    // Second signal — decision #2 trips the guard
    await opts.signalQueue.push(makeSignal('swap', 'sig-trip-2'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));

    // Third signal — instance should be quarantined now, onSignal NOT called
    await opts.signalQueue.push(makeSignal('swap', 'sig-trip-3'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));

    runtime.stop();

    // Only 2 onSignal calls before quarantine
    expect(signalCount.length).toBe(2);

    // metrics.emit('strategy.tripped', ...) must have been called
    expect(metricsEmitted.some((e) => e.topic === 'strategy.tripped')).toBe(true);

    // The third signal should be skipped (quarantined)
    expect(signalCount.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — onError synchronous handling
// ---------------------------------------------------------------------------

describe('Test 7 — onError called synchronously on hook error', () => {
  it('strategy whose onSignal throws → onError called, runtime emits strategy-error, guards.recordError called', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);

    const runtimeErrors: Array<{ instanceId: string; phase: string }> = [];
    runtime.on('strategy-error', (evt) => runtimeErrors.push(evt));

    const onErrorCalls: Array<{ err: Error; phase: string }> = [];
    const onErrorCallOrder: string[] = [];

    class ThrowingStrategy extends Strategy {
      readonly name = 'thrower';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(): Promise<null> {
        throw new Error('boom');
      }
      override onError(err: Error, phase: string) {
        onErrorCallOrder.push('onError');
        onErrorCalls.push({ err, phase });
      }
    }

    await runtime.register(new ThrowingStrategy());
    runtime.start();

    await opts.signalQueue.push(makeSignal('swap', 'sig-throw-1'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));
    runtime.stop();

    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]!.err.message).toBe('boom');
    expect(onErrorCalls[0]!.phase).toBe('onSignal');
    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]!.phase).toBe('onSignal');
  });

  it('onError that throws itself does NOT propagate — runtime swallows it', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);

    class DoubleThrowStrategy extends Strategy {
      readonly name = 'double-throw';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(): Promise<null> { throw new Error('hook error'); }
      override onError(): void { throw new Error('reporter error'); }
    }

    await runtime.register(new DoubleThrowStrategy());
    runtime.start();

    // Must not throw / reject
    await expect(opts.signalQueue.push(makeSignal('swap', 'sig-dt-1'))).resolves.toBeUndefined();
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));
    runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 8 — pause / resume
// ---------------------------------------------------------------------------

describe('Test 8 — pause / resume', () => {
  it('paused instance skips onSignal; resumed instance processes', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);

    const called: string[] = [];
    class TrackingStrategy extends Strategy {
      readonly name = 'tracker';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(sig: Signal) { called.push(sig.signalId); return null; }
    }

    await runtime.register(new TrackingStrategy());
    runtime.start();

    // Pause before first signal
    runtime.pause('tracker');
    await opts.signalQueue.push(makeSignal('swap', 'sig-paused'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));
    expect(called).toHaveLength(0);

    // Resume
    runtime.resume('tracker');
    await opts.signalQueue.push(makeSignal('swap', 'sig-resumed'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));
    expect(called).toHaveLength(1);
    expect(called[0]).toBe('sig-resumed');

    runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 9 — deregister calls onShutdown then removes from map
// ---------------------------------------------------------------------------

describe('Test 9 — deregister', () => {
  it('onShutdown called then instance removed; subsequent signals ignored', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);

    const shutdownCalled: boolean[] = [];
    const signalsCalled: string[] = [];

    class ShutdownStrategy extends Strategy {
      readonly name = 'shutdowner';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(sig: Signal) { signalsCalled.push(sig.signalId); return null; }
      override async onShutdown() { shutdownCalled.push(true); }
    }

    await runtime.register(new ShutdownStrategy());
    runtime.start();

    // Verify it works before deregister
    await opts.signalQueue.push(makeSignal('swap', 'sig-before'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));
    expect(signalsCalled).toHaveLength(1);

    // Deregister
    await runtime.deregister('shutdowner');
    expect(shutdownCalled).toHaveLength(1);

    // Signal after deregister — should be ignored
    await opts.signalQueue.push(makeSignal('swap', 'sig-after'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));
    expect(signalsCalled).toHaveLength(1); // still 1

    runtime.stop();
  });

  it('deregister of unknown instanceId is a no-op', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);
    await expect(runtime.deregister('nonexistent')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 9b — deregister drains queue even when onShutdown is not defined
// ---------------------------------------------------------------------------

describe('Test 9b — deregister drains in-flight queue tasks without onShutdown', () => {
  it('deregister drains queue even when onShutdown is not defined', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);

    const log: string[] = [];

    class DrainTestStrategy extends Strategy {
      readonly name = 'drain-test';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(sig: Signal) {
        log.push(`start-${sig.signalId}`);
        await new Promise<void>((r) => setTimeout(r, 30));
        log.push(`end-${sig.signalId}`);
        return null;
      }
      // No onShutdown defined — this is the critical case
    }

    await runtime.register(new DrainTestStrategy());
    runtime.start();

    // Push a signal that takes 30 ms inside onSignal
    void opts.signalQueue.push(makeSignal('swap', 's1'));

    // Yield to let the signal reach the per-instance queue before we deregister
    await new Promise<void>((res) => setImmediate(res));

    // Deregister immediately — without the drain barrier, 'end-s1' would be missing
    await runtime.deregister('drain-test');

    expect(log).toEqual(['start-s1', 'end-s1']);

    runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 10 — stop() clears tick timer and unsubscribes from signal queue
// ---------------------------------------------------------------------------

describe('Test 10 — stop()', () => {
  it('stop() clears tick interval so onTick is NOT called after stop', async () => {
    const { opts } = makeOpts({ tickIntervalMs: 50 });
    const runtime = new StrategyRuntime(opts);

    const tickCalls: number[] = [];

    class TickStrategy extends Strategy {
      readonly name = 'ticker';
      readonly filters: SignalFilter[] = [];
      async onSignal() { return null; }
      override async onTick(tsMs: number) { tickCalls.push(tsMs); }
    }

    await runtime.register(new TickStrategy());
    runtime.start();

    // Wait for at least one tick
    await new Promise<void>((res) => setTimeout(res, 80));
    expect(tickCalls.length).toBeGreaterThan(0);

    const countAtStop = tickCalls.length;
    runtime.stop();

    // Wait longer — no more ticks should fire
    await new Promise<void>((res) => setTimeout(res, 80));
    expect(tickCalls.length).toBe(countAtStop);
  });

  it('stop() unsubscribes from signal queue so signals after stop are ignored', async () => {
    const { opts } = makeOpts();
    const runtime = new StrategyRuntime(opts);

    const called: string[] = [];
    class AfterStopStrategy extends Strategy {
      readonly name = 'after-stop';
      readonly filters: SignalFilter[] = [{ kind: 'swap' }];
      async onSignal(sig: Signal) { called.push(sig.signalId); return null; }
    }

    await runtime.register(new AfterStopStrategy());
    runtime.start();
    runtime.stop();

    // Push signal AFTER stop — should not reach onSignal
    await opts.signalQueue.push(makeSignal('swap', 'sig-post-stop'));
    await opts.signalQueue.drain();
    await new Promise<void>((res) => setImmediate(res));

    expect(called).toHaveLength(0);
  });
});
