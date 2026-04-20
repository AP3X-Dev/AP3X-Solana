/**
 * backtest.ts — deterministic backtest harness for @ap3x/solana-strategy.
 *
 * Phase D, Task 43.
 *
 * Wires: FixtureSignalSource → SignalQueue → StrategyRuntime
 *        → SimulatedExecutor (no-op RpcPool) → InMemoryPortfolio
 *
 * Gate 6 determinism contract:
 *   Re-running with the same `clock`, `rng`, and fixture produces byte-identical
 *   `decisionLog` + `lifecycleLog`. Enforced by:
 *     - No Date.now() anywhere in this file.
 *     - No Math.random() anywhere in this file.
 *     - Deterministic mulberry32 PRNG seeded at 0 per run.
 *     - Simulated latency advances the supplied clock counter; no real timers.
 *
 * Design notes:
 *   - SimulatedExecutor and InMemoryPortfolio are NOT exported; they are
 *     internal to the harness. Callers interact only via runBacktest().
 *   - Portfolio mutation requires an `intentToTrade` callback (Option C).
 *     Without it, the harness still captures decisions and lifecycle for
 *     reasoning about strategy logic without needing trade semantics.
 *   - The adapter (adaptToLandedTrades + RPC fetch) is bypassed in backtest.
 *     A fake no-op RpcPool is provided to StrategyRuntime for completeness,
 *     but the SimulatedExecutor calls inMemoryPortfolio.applyLandedTrade()
 *     directly via the intentToTrade callback — "Option A bypass".
 */

import { EventEmitter } from 'node:events';

import { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';
import { SignalQueue } from '@ap3x/solana-signals';
import type { FixtureSignalSource } from '@ap3x/solana-signals';
import type { TradeIntent, ExecutionResult } from '@ap3x/solana-executor';
import type { LandedTrade, Position, PositionChange } from '@ap3x/solana-portfolio';
import type { WalletHandle } from '@ap3x/solana-vault';

import { Strategy } from './strategy.js';
import { StrategyRuntime } from './runtime.js';
import type { ExecutorLike, PortfolioLike } from './runtime.js';
import type { RpcPoolLike } from './landed-trade-adapter.js';
import type { StrategyStateStore } from './context.js';
import type { HookPhase } from './strategy.js';

// ---------------------------------------------------------------------------
// Mulberry32 — deterministic PRNG (5 lines). Seeded per run.
// ---------------------------------------------------------------------------

function makeMulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SimulatedExecutorConfig {
  /** Probability a submit lands. 0.0–1.0. Default 1.0 (always lands). */
  landingSuccessRate?: number;
  /**
   * Min simulated latency in "ticks". The clock is advanced by a value between
   * min and max before emitting the result. Actual real-time `await` does NOT
   * happen — determinism requires we never sleep on real time.
   * Default 0.
   */
  minLatencyMs?: number;
  /** Max simulated latency ticks. Default 0. */
  maxLatencyMs?: number;
}

export interface BacktestOpts {
  strategy: Strategy;
  fixtureSource: FixtureSignalSource;
  /** Deterministic clock. Called for every timestamp in decision/lifecycle logs. */
  clock: () => number;
  /**
   * Injected random number generator. If not supplied, a mulberry32 PRNG
   * seeded at 0 is used. Reset per backtest run — pass the same factory to
   * get identical results across runs.
   */
  rng?: () => number;
  simulatedExecutor?: SimulatedExecutorConfig;
  /**
   * Optional callback that converts a TradeIntent + ExecutionResult into
   * LandedTrade records so the in-memory portfolio can be updated.
   *
   * If not supplied (default), no portfolio mutations occur — the backtest
   * still captures decisions and lifecycle correctly.
   *
   * Strategy authors who want portfolio tracking supply this; the harness
   * doesn't peek into opaque instructions.
   */
  intentToTrade?: (intent: TradeIntent, result: ExecutionResult) => LandedTrade[];
}

export interface BacktestResult {
  /** Every TradeIntent that produced a non-null decision. */
  trades: TradeIntent[];
  /** Sum of realized PnL across all wallets in the in-memory portfolio. */
  realizedPnl: bigint;
  /** Per-decision record for determinism comparison (gate 6). */
  decisionLog: Array<{ intentId: string; signalId: string; tsMs: number }>;
  /** Per-hook-invocation record for determinism comparison (gate 6). */
  lifecycleLog: Array<{ phase: string; tsMs: number; meta?: Record<string, unknown> }>;
  /** All positions at end of run. */
  finalPositions: unknown[];
}

// ---------------------------------------------------------------------------
// InMemoryStrategyStateStore — no-op for backtest
// ---------------------------------------------------------------------------

class InMemoryStrategyStateStore implements StrategyStateStore {
  private readonly m = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> { return (this.m.get(key) as T) ?? null; }
  async set<T>(key: string, value: T): Promise<void> { this.m.set(key, value); }
  async delete(key: string): Promise<void> { this.m.delete(key); }
  async list(prefix?: string): Promise<string[]> {
    const keys = [...this.m.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }
}

// ---------------------------------------------------------------------------
// InMemoryPortfolio — implements PortfolioLike without disk I/O
// ---------------------------------------------------------------------------

/**
 * Aggregates position lots per (wallet, mint). No disk I/O.
 * Accounting mirrors FilePortfolioStore (FIFO lot reduction via inline
 * reduceLots-equivalent). Deterministic — no Date.now() calls.
 */
class InMemoryPortfolio extends EventEmitter implements PortfolioLike {
  // wallet-base58 → mint-base58 → Position
  private readonly positions = new Map<string, Map<string, Position>>();
  // wallet-base58 → realized PnL
  private readonly realizedPnl = new Map<string, bigint>();

  async getPosition(wallet: PublicKey, mint: PublicKey): Promise<Position | null> {
    return this.positions.get(wallet.toBase58())?.get(mint.toBase58()) ?? null;
  }

  async getAllPositions(wallet: PublicKey): Promise<Position[]> {
    const byMint = this.positions.get(wallet.toBase58());
    return byMint ? [...byMint.values()] : [];
  }

  async getRealizedPnl(wallet: PublicKey, _mint: PublicKey): Promise<bigint> {
    return this.realizedPnl.get(wallet.toBase58()) ?? 0n;
  }

  async getUnrealizedPnl(
    _wallet: PublicKey,
    _mint: PublicKey,
    _currentPriceLamports: bigint,
  ): Promise<bigint> {
    return 0n;
  }

  async applyLandedTrade(trade: LandedTrade): Promise<PositionChange[]> {
    const walletStr = trade.wallet.toBase58();
    const mintStr = trade.mint.toBase58();

    if (!this.positions.has(walletStr)) this.positions.set(walletStr, new Map());
    const byMint = this.positions.get(walletStr)!;

    const existing = byMint.get(mintStr) ?? null;
    const before: Position | null = existing
      ? {
          mint: existing.mint,
          walletAddress: existing.walletAddress,
          lastUpdatedSlot: existing.lastUpdatedSlot,
          lots: existing.lots.map((l) => ({ ...l })),
        }
      : null;

    let pos: Position = existing ?? {
      mint: trade.mint,
      walletAddress: trade.wallet,
      lots: [],
      lastUpdatedSlot: 0,
    };

    if (trade.amountDelta > 0n) {
      const lot = {
        amount: trade.amountDelta,
        costBasisLamports: trade.solFlowLamports < 0n ? -trade.solFlowLamports : 0n,
        acquiredSlot: trade.slot,
        acquiredSig: trade.signature,
        source: 'trade' as const,
      };
      pos = { ...pos, lots: [...pos.lots, lot], lastUpdatedSlot: trade.slot };
    } else if (trade.amountDelta < 0n) {
      // Inline FIFO lot reduction (mirrors FilePortfolioStore)
      const { remaining, realized } = inlineReduceLotsFifo(
        pos.lots,
        -trade.amountDelta,
        trade.solFlowLamports > 0n ? trade.solFlowLamports : 0n,
      );
      const prev = this.realizedPnl.get(walletStr) ?? 0n;
      this.realizedPnl.set(walletStr, prev + realized);
      pos = { ...pos, lots: remaining, lastUpdatedSlot: trade.slot };
      this.emit('realized-pnl', {
        wallet: trade.wallet,
        mint: trade.mint,
        realized,
        slot: trade.slot,
      });
    }

    byMint.set(mintStr, pos);

    const change: PositionChange = {
      wallet: trade.wallet,
      mint: trade.mint,
      before,
      after: pos,
      reason: 'apply-landed-trade',
    };
    this.emit('change', change);
    return [change];
  }

  /** Sum realized PnL across all wallets. */
  totalRealizedPnl(): bigint {
    let total = 0n;
    for (const v of this.realizedPnl.values()) total += v;
    return total;
  }

  /** Flat array of all positions across all wallets. */
  allPositionsFlat(): Position[] {
    const out: Position[] = [];
    for (const byMint of this.positions.values()) {
      for (const pos of byMint.values()) out.push(pos);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Inline FIFO lot reduction (mirrors accounting.ts without importing it)
// ---------------------------------------------------------------------------

function inlineReduceLotsFifo(
  lots: Position['lots'],
  amount: bigint,
  proceedsLamports: bigint,
): { remaining: Position['lots']; realized: bigint } {
  if (amount <= 0n) return { remaining: lots, realized: 0n };

  let toTake = amount;
  let costBasis = 0n;
  let allocatedProceeds = 0n;
  const out: Position['lots'] = [];

  for (const l of lots) {
    if (toTake === 0n) { out.push(l); continue; }
    const tokensTaken = l.amount <= toTake ? l.amount : toTake;
    const partialBasis = (l.costBasisLamports * tokensTaken) / l.amount;
    const denom = l.amount > amount ? l.amount : amount;
    const lotProceeds = (proceedsLamports * tokensTaken) / denom;
    costBasis += partialBasis;
    allocatedProceeds += lotProceeds;
    toTake -= tokensTaken;
    if (tokensTaken < l.amount) {
      out.push({
        ...l,
        amount: l.amount - tokensTaken,
        costBasisLamports: l.costBasisLamports - partialBasis,
      });
    }
  }

  // If we couldn't reduce fully (short inventory), just clear what we could
  return { remaining: out, realized: allocatedProceeds - costBasis };
}

// ---------------------------------------------------------------------------
// SimulatedExecutor — implements ExecutorLike
// ---------------------------------------------------------------------------

class SimulatedExecutor extends EventEmitter implements ExecutorLike {
  private readonly landingSuccessRate: number;
  private readonly minLatencyMs: number;
  private readonly maxLatencyMs: number;
  private readonly rng: () => number;
  private readonly clock: () => number;
  private readonly intentToTrade: ((intent: TradeIntent, result: ExecutionResult) => LandedTrade[]) | undefined;
  private readonly portfolio: InMemoryPortfolio;
  private readonly decisionLog: BacktestResult['decisionLog'];
  private readonly capturedTrades: TradeIntent[];
  private readonly signalIdByIntent: Map<string, string>;

  constructor(opts: {
    config: SimulatedExecutorConfig;
    rng: () => number;
    clock: () => number;
    intentToTrade: BacktestOpts['intentToTrade'];
    portfolio: InMemoryPortfolio;
    decisionLog: BacktestResult['decisionLog'];
    capturedTrades: TradeIntent[];
    signalIdByIntent: Map<string, string>;
  }) {
    super();
    this.landingSuccessRate = opts.config.landingSuccessRate ?? 1.0;
    this.minLatencyMs = opts.config.minLatencyMs ?? 0;
    this.maxLatencyMs = opts.config.maxLatencyMs ?? 0;
    this.rng = opts.rng;
    this.clock = opts.clock;
    this.intentToTrade = opts.intentToTrade;
    this.portfolio = opts.portfolio;
    this.decisionLog = opts.decisionLog;
    this.capturedTrades = opts.capturedTrades;
    this.signalIdByIntent = opts.signalIdByIntent;
  }

  async submit(intent: TradeIntent): Promise<ExecutionResult> {
    // Record the trade intent
    this.capturedTrades.push(intent);

    // Simulate latency by bumping clock conceptually (no real await)
    // We record tsMs at decision time via the lifecycle wrapper, so here we
    // just advance the clock pointer if latency is configured.
    let simulatedSlot = 0;
    if (this.minLatencyMs > 0 || this.maxLatencyMs > 0) {
      const latency =
        this.minLatencyMs +
        Math.floor(this.rng() * (this.maxLatencyMs - this.minLatencyMs + 1));
      // Advance the clock by latency ticks (the clock function is expected to
      // be a counter; callers can make it increment on each call).
      // We consume latency calls to advance the counter deterministically.
      for (let i = 0; i < latency; i++) this.clock();
      simulatedSlot = latency;
    }

    const landedAt = this.clock();
    const doesLand = this.rng() < this.landingSuccessRate;

    // Synthesize a deterministic signature from the intentId so re-runs are
    // byte-identical. We use a simple hash: base64url of the intentId bytes.
    const deterministicSig = `sim-${intent.intentId}`;

    let result: ExecutionResult;
    if (doesLand) {
      result = {
        kind: 'landed',
        intentId: intent.intentId,
        signature: deterministicSig,
        slot: simulatedSlot,
        submitterUsed: 'simulated',
        landedAt,
      };

      // Apply trade via intentToTrade callback (Option C). If not supplied,
      // no portfolio mutation happens — decisionLog still captures the intent.
      if (this.intentToTrade) {
        const trades = this.intentToTrade(intent, result);
        for (const trade of trades) {
          await this.portfolio.applyLandedTrade(trade);
        }
      }
    } else {
      result = {
        kind: 'rejected',
        intentId: intent.intentId,
        submitterUsed: 'simulated',
        error: { code: 'simulated_failure', message: 'Simulated execution failure' },
      };
    }

    // Record decision log entry (intentId + signalId + tsMs)
    const signalId = this.signalIdByIntent.get(intent.intentId) ?? '';
    this.decisionLog.push({
      intentId: intent.intentId,
      signalId,
      tsMs: landedAt,
    });

    this.emit('result', result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// InstrumentedStrategy — wraps a Strategy to capture lifecycle hooks
//
// Only overrides optional hooks (onStart, onShutdown, onExecutionResult,
// onPositionChange, onTick) if the inner strategy defines them. This keeps
// the runtime's dispatch path identical to a non-instrumented run, which is
// required for gate-6 determinism: if the inner strategy doesn't have
// onExecutionResult, the runtime never calls it (and never consumes a clock
// tick for it), so clock values are byte-identical across runs.
// ---------------------------------------------------------------------------

class InstrumentedStrategy extends Strategy {
  readonly name: string;
  readonly filters: Strategy['filters'];

  /** Used internally — set in onSignal before returning decision, cleared in submit. */
  _pendingSignalId: string | null = null;

  private readonly inner: Strategy;
  private readonly lifecycleLog: BacktestResult['lifecycleLog'];
  private readonly clock: () => number;
  private readonly signalIdByIntent: Map<string, string>;

  constructor(
    inner: Strategy,
    lifecycleLog: BacktestResult['lifecycleLog'],
    clock: () => number,
    signalIdByIntent: Map<string, string>,
  ) {
    super();
    this.inner = inner;
    this.name = inner.name;
    this.filters = inner.filters;
    this.lifecycleLog = lifecycleLog;
    this.clock = clock;
    this.signalIdByIntent = signalIdByIntent;

    // Conditionally install optional hooks only when the inner strategy has
    // them. This prevents the runtime from dispatching (and consuming clock
    // ticks for) hooks that don't exist on the inner strategy.
    if (inner.onStart) {
      this.onStart = async (ctx) => {
        this.logPhase('onStart');
        await inner.onStart!(ctx);
      };
    }
    if (inner.onShutdown) {
      this.onShutdown = async (ctx) => {
        this.logPhase('onShutdown');
        await inner.onShutdown!(ctx);
      };
    }
    if (inner.onExecutionResult) {
      this.onExecutionResult = async (result, ctx) => {
        this.logPhase('onExecutionResult', { kind: result.kind, intentId: result.intentId });
        await inner.onExecutionResult!(result, ctx);
      };
    }
    if (inner.onPositionChange) {
      this.onPositionChange = async (change, ctx) => {
        this.logPhase('onPositionChange');
        await inner.onPositionChange!(change, ctx);
      };
    }
    if (inner.onTick) {
      // v8 ignore next 4 — runBacktest sets tickIntervalMs to MAX_INT so onTick
      // is never dispatched during a signal-driven backtest run.
      /* v8 ignore next 4 */
      this.onTick = async (tsMs, ctx) => {
        this.logPhase('onTick', { tsMs });
        await inner.onTick!(tsMs, ctx);
      };
    }
    if (inner.onError) {
      this.onError = (err, phase, ctx) => {
        inner.onError!(err, phase, ctx);
      };
    }
  }

  private logPhase(phase: HookPhase, meta?: Record<string, unknown>): void {
    this.lifecycleLog.push({ phase, tsMs: this.clock(), ...(meta ? { meta } : {}) });
  }

  override async onSignal(
    signal: Signal,
    ctx: Parameters<Strategy['onSignal']>[1],
  ): ReturnType<Strategy['onSignal']> {
    this.logPhase('onSignal', { signalId: signal.signalId });
    const decision = await this.inner.onSignal(signal, ctx);

    // Record the pending signalId so the submit wrapper can populate
    // signalIdByIntent. Per-instance queue serialization guarantees this is
    // always the current signal.
    if (decision !== null) {
      this._pendingSignalId = signal.signalId;
    }
    return decision;
  }
}

// ---------------------------------------------------------------------------
// Fake WalletHandle — deterministic per wallet name
// ---------------------------------------------------------------------------

/** Produce a deterministic 32-byte address from a wallet name string. */
function deterministicAddress(name: string): PublicKey {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < name.length && i < 32; i++) {
    bytes[i] = name.charCodeAt(i) & 0xff;
  }
  // Fill remaining with a hash-like spread so different names don't alias
  for (let i = name.length; i < 32; i++) {
    bytes[i] = ((bytes[i - 1]! * 31 + i) & 0xff);
  }
  return PublicKey.fromBytes(bytes);
}

function makeFakeWalletHandle(name: string): WalletHandle {
  const address = deterministicAddress(name);
  return {
    address,
    role: 'backtest',
    sign: async (_msg: Uint8Array) => new Uint8Array(64),
    signTransaction: async (_tx: Uint8Array) => new Uint8Array(65),
    isLocked: false,
    _lock: () => {},
    toJSON: () => ({ address: address.toBase58(), role: 'backtest', locked: false }),
  } as unknown as WalletHandle;
}

// ---------------------------------------------------------------------------
// No-op RpcPool — backtest bypasses the adapter path
// ---------------------------------------------------------------------------

const noopRpcPool: RpcPoolLike = {
  async call(_method: string, _params: unknown): Promise<unknown> {
    return null;
  },
};

// ---------------------------------------------------------------------------
// runBacktest — main entry point
// ---------------------------------------------------------------------------

/**
 * Run a deterministic backtest.
 *
 * Wiring:
 *   FixtureSignalSource → bridge → SignalQueue → StrategyRuntime
 *     → SimulatedExecutor → (intentToTrade cb) → InMemoryPortfolio
 *
 * All timestamps come from `opts.clock`. No Date.now() or Math.random() calls.
 * Re-running with the same clock, rng, and fixture produces byte-identical
 * decisionLog + lifecycleLog (gate 6).
 */
export async function runBacktest(opts: BacktestOpts): Promise<BacktestResult> {
  // Resolve RNG — default mulberry32 seeded at 0 for determinism
  const rng = opts.rng ?? makeMulberry32(0);

  // Shared accumulators
  const decisionLog: BacktestResult['decisionLog'] = [];
  const lifecycleLog: BacktestResult['lifecycleLog'] = [];
  const capturedTrades: TradeIntent[] = [];
  const signalIdByIntent = new Map<string, string>();

  // 1. In-memory portfolio
  const portfolio = new InMemoryPortfolio();

  // 2. Simulated executor
  const executorCfg = opts.simulatedExecutor ?? {};
  const simulatedExecutor = new SimulatedExecutor({
    config: executorCfg,
    rng,
    clock: opts.clock,
    intentToTrade: opts.intentToTrade,
    portfolio,
    decisionLog,
    capturedTrades,
    signalIdByIntent,
  });

  // 3. Signal queue
  const signalQueue = new SignalQueue();

  // 4. Instrument the strategy to capture lifecycle hooks
  const instrumented = new InstrumentedStrategy(
    opts.strategy,
    lifecycleLog,
    opts.clock,
    signalIdByIntent,
  );

  // 5. Build StrategyRuntime
  const runtime = new StrategyRuntime({
    signalQueue,
    executor: simulatedExecutor,
    portfolio,
    resolveWallet: async (name: string) => makeFakeWalletHandle(name),
    rpcPool: noopRpcPool,
    clock: opts.clock,
    // Disable the tick interval — backtest is signal-driven, not time-driven.
    // 2_147_483_647 ms is the max safe 32-bit signed integer; setInterval stays
    // well below the overflow threshold (which Node re-clamps to 1ms).
    tickIntervalMs: 2_147_483_647,
    stateStoreFactory: (_sn: string, _id: string) => new InMemoryStrategyStateStore(),
  });

  // 6. Wire executor → signalIdByIntent: the InstrumentedStrategy records
  //    _pendingSignalId just before returning the decision. The runtime then
  //    derives the intentId and calls executor.submit. We intercept via a
  //    wrapper around runtime's dispatchSignal indirectly by patching the
  //    executor's submit to read _pendingSignalId at call time.
  //
  //    Implementation: we override submit on the simulated executor via a proxy
  //    that reads instrumented._pendingSignalId at the moment of submit.
  //    Since dispatch is per-instance serialized, this is always the correct signal.
  const originalSubmit = simulatedExecutor.submit.bind(simulatedExecutor);
  simulatedExecutor.submit = async function (intent: TradeIntent): Promise<ExecutionResult> {
    // Capture signalId → intentId mapping just before submit
    if (instrumented._pendingSignalId !== null) {
      signalIdByIntent.set(intent.intentId, instrumented._pendingSignalId);
      instrumented._pendingSignalId = null;
    }
    return originalSubmit(intent);
  };

  // 7. Register the instrumented strategy and start the runtime
  await runtime.register(instrumented);
  runtime.start();

  // 8. Bridge: FixtureSignalSource 'signal' events → SignalQueue.push
  opts.fixtureSource.on('signal', (sig: Signal) => {
    void signalQueue.push(sig);
  });

  // 9. Start the fixture source and wait for 'end'
  await new Promise<void>((resolve, reject) => {
    opts.fixtureSource.once('end', resolve);
    opts.fixtureSource.once('error', reject);
    void opts.fixtureSource.start();
  });

  // 10. Drain the signal queue and wait for all in-flight tasks to settle.
  //     Multiple rounds of drain + setImmediate ensure the per-instance queue
  //     chains complete before we read results.
  await signalQueue.drain();
  await new Promise<void>((res) => setImmediate(res));
  await new Promise<void>((res) => setImmediate(res));
  await new Promise<void>((res) => setImmediate(res));

  // 11. Stop the runtime
  runtime.stop();
  await runtime.deregister(instrumented.name);

  // 12. Build and return BacktestResult
  return {
    trades: capturedTrades,
    realizedPnl: portfolio.totalRealizedPnl(),
    decisionLog,
    lifecycleLog,
    finalPositions: portfolio.allPositionsFlat(),
  };
}
