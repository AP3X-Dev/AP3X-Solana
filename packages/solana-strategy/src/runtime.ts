/**
 * StrategyRuntime — orchestrator for the signals → strategies → executor → portfolio pipeline.
 *
 * Phase D, Task 42.
 *
 * Wiring overview:
 *   1. `start()` — subscribe to SignalQueue, executor 'result' events, portfolio 'change' events,
 *      and a per-tick setInterval.
 *   2. `register(strategy, instanceId?)` — build a per-instance record with its own InstanceQueue,
 *      GuardTracker, StrategyContext, and wallet-address cache.
 *   3. `dispatchSignal` — for each instance, if not quarantined and filter matches:
 *      enqueue [onSignal → guard check → executor.submit → adaptToLandedTrades → portfolio.applyLandedTrade].
 *      The ENTIRE callback (including executor.submit) lives inside the per-instance queue so
 *      that submit is serialized alongside hook calls for a given instance.
 *      (Advisor note 4 / gate-6 determinism: serialising submit ensures two signals for the same
 *      instance can never submit concurrently and produce interleaved intentId conflicts or
 *      out-of-order portfolio mutations.)
 *   4. `tripGuard` — idempotent quarantine + metrics + onShutdown. Does NOT deregister — the
 *      instance stays in the map so subsequent metrics can attribute "quarantined" to it.
 *
 * Carryover corrections from Phase C (applied here):
 *   C1: `resolveWallet` seam — no `vault: Vault` field; callers own passphrase resolution.
 *   C2: executor.submit runs INSIDE the per-instance queue (see dispatchSignal comment).
 *   C3: ExecutionResult 'dropped' kind — handled by adaptToLandedTrades (returns []).
 *   C4: Runtime does NOT call feeEstimator.tier(); strategies set feeTier on TradeIntent.
 *   C5: Runtime does NOT prepend compute-budget instructions; deferred to PRP-03.
 */

import { EventEmitter } from 'node:events';

import type { PublicKey } from '@ap3x/solana-core';
import type { Signal } from '@ap3x/solana-signals';
import type { SignalQueue } from '@ap3x/solana-signals';
import type { ExecutionResult, TradeIntent } from '@ap3x/solana-executor';
import type { PositionChange, LandedTrade } from '@ap3x/solana-portfolio';
import type { WalletHandle } from '@ap3x/solana-vault';

import { Strategy, type HookPhase } from './strategy.js';
import { matchesAny } from './filter.js';
import { InstanceQueue } from './instance-queue.js';
import { intentId } from './intent-id.js';
import { adaptToLandedTrades, type RpcPoolLike } from './landed-trade-adapter.js';
import { GuardTracker, type GuardConfig, type GuardTrip } from './guards.js';
import type { StrategyContext, PriceSource, Logger, MetricsEmitter, StrategyStateStore } from './context.js';
import { FileStrategyStateStore } from './state-store-file.js';

// ---------------------------------------------------------------------------
// Narrow interface types — T43 and tests can swap these without full impls.
// ---------------------------------------------------------------------------

/**
 * Minimal executor surface consumed by StrategyRuntime. The real Executor
 * satisfies this interface. A simulated executor (T43) or a test fake can
 * implement just these two members.
 */
export interface ExecutorLike {
  submit(intent: TradeIntent): Promise<ExecutionResult>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

/**
 * Minimal portfolio surface consumed by StrategyRuntime. The real
 * FilePortfolioStore satisfies this interface.
 */
export interface PortfolioLike {
  applyLandedTrade(trade: LandedTrade): Promise<PositionChange[]>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StrategyRuntimeOpts {
  signalQueue: SignalQueue;
  /**
   * Executor (or ExecutorLike) to submit TradeIntents.
   * C1 carryover: vault access is NOT on this type — passphrase resolution
   * is the composition layer's responsibility, injected via `resolveWallet`.
   */
  executor: ExecutorLike;
  portfolio: PortfolioLike;
  /**
   * Resolves a wallet name to an unlocked WalletHandle. The composition layer
   * (CLI, service boot, tests) owns passphrase resolution. The runtime never
   * holds passphrases.
   *
   * Carryover C1: replaces the rejected `vault: Vault` field from the plan.
   */
  resolveWallet: (name: string) => Promise<WalletHandle>;
  rpcPool: RpcPoolLike;
  priceSource?: PriceSource;
  /** Defaults to `Date.now`. */
  clock?: () => number;
  /** Tick interval in ms. Default: 1000. */
  tickIntervalMs?: number;
  /** Guard config applied to every registered instance. Default: `{}`. */
  guards?: GuardConfig;
  /**
   * Factory for per-instance state stores. Default: `FileStrategyStateStore`
   * under `.ap3x/strategy/<strategyName>/<instanceId>/`.
   */
  stateStoreFactory?: (strategyName: string, instanceId: string) => StrategyStateStore;
  logger?: Logger;
  metrics?: MetricsEmitter;
}

// ---------------------------------------------------------------------------
// Internal per-instance record (not exported — use StrategyRuntime API)
// ---------------------------------------------------------------------------

interface InstanceRecord {
  strategy: Strategy;
  instanceId: string;
  ctx: StrategyContext;
  queue: InstanceQueue;
  guards: GuardTracker;
  quarantined: boolean;
  /** Immutable cache: wallet name → resolved public key. Wallet addresses never change. */
  walletAddresses: Map<string, PublicKey>;
}

// ---------------------------------------------------------------------------
// No-op defaults
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const noopMetrics: MetricsEmitter = { emit: () => {} };

// ---------------------------------------------------------------------------
// StrategyRuntime
// ---------------------------------------------------------------------------

export class StrategyRuntime extends EventEmitter {
  private readonly instances = new Map<string, InstanceRecord>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  // Resolved opts with defaults applied
  private readonly clock: () => number;
  private readonly tickIntervalMs: number;
  private readonly guardsCfg: GuardConfig;
  private readonly stateStoreFactory: (sn: string, id: string) => StrategyStateStore;
  private readonly logger: Logger;
  private readonly metrics: MetricsEmitter;

  // Signal queue subscription name — unique per runtime instance
  private readonly signalSubName: string;

  constructor(private readonly opts: StrategyRuntimeOpts) {
    super();
    this.clock = opts.clock ?? Date.now;
    this.tickIntervalMs = opts.tickIntervalMs ?? 1_000;
    this.guardsCfg = opts.guards ?? {};
    this.stateStoreFactory =
      opts.stateStoreFactory ??
      ((sn, id) => new FileStrategyStateStore({ strategyName: sn, instanceId: id }));
    this.logger = opts.logger ?? noopLogger;
    this.metrics = opts.metrics ?? noopMetrics;
    // Use a unique subscription name so multiple runtimes can coexist in tests
    this.signalSubName = `strategy-runtime-${Math.random().toString(36).slice(2)}`;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Register a strategy and optionally assign a custom instanceId.
   * Defaults to `strategy.name`. Throws if the id is already registered.
   * If `onStart` is defined, it is dispatched through the instance queue and
   * `register` awaits its completion before returning.
   */
  async register(strategy: Strategy, instanceId?: string): Promise<void> {
    const id = instanceId ?? strategy.name;
    if (this.instances.has(id)) {
      throw new Error(`instance ${id} already registered`);
    }

    const state = this.stateStoreFactory(strategy.name, id);

    // C1 carryover: vault read API delegates to resolveWallet; never holds a Vault reference.
    const vaultReadApi = {
      getAddress: async (name: string): Promise<PublicKey> => {
        const handle = await this.opts.resolveWallet(name);
        return handle.address;
      },
      list: async () => [] as Array<{ name: string; role: string; address: PublicKey }>,
    };

    // exactOptionalPropertyTypes: only include priceSource when defined so
    // we don't assign `undefined` to an optional field that expects absence.
    const ctx: StrategyContext = {
      portfolio: this.opts.portfolio as any, // PortfolioLike satisfies PortfolioReadApi for the fields strategies use
      vault: vaultReadApi,
      state,
      metrics: this.metrics,
      ...(this.opts.priceSource !== undefined ? { priceSource: this.opts.priceSource } : {}),
      logger: this.logger,
      now: this.clock,
    };

    const record: InstanceRecord = {
      strategy,
      instanceId: id,
      ctx,
      queue: new InstanceQueue(),
      guards: new GuardTracker(this.guardsCfg, this.clock),
      quarantined: false,
      walletAddresses: new Map(),
    };

    this.instances.set(id, record);

    if (strategy.onStart) {
      await record.queue.enqueue(() =>
        this.callHook(record, 'onStart', () => strategy.onStart!(ctx)),
      );
    }
  }

  /**
   * Deregister a strategy. If `onShutdown` is defined it is dispatched through
   * the queue before the instance is removed from the map.
   */
  async deregister(instanceId: string): Promise<void> {
    const rec = this.instances.get(instanceId);
    if (!rec) return;

    if (rec.strategy.onShutdown) {
      await rec.queue.enqueue(() =>
        this.callHook(rec, 'onShutdown', () => rec.strategy.onShutdown!(rec.ctx)),
      );
    }

    this.instances.delete(instanceId);
  }

  /**
   * Start dispatching signals, executor results, portfolio changes, and ticks.
   */
  start(): void {
    this.opts.signalQueue.subscribe(this.signalSubName, (sig: Signal) =>
      this.dispatchSignal(sig),
    );

    // executor 'result' event — broadcast to all registered instances
    this.opts.executor.on('result', (r: unknown) =>
      this.dispatchExecutionResult(r as ExecutionResult),
    );

    // portfolio 'change' event — broadcast to all registered instances
    // This intentionally includes changes the runtime itself caused via applyLandedTrade,
    // as well as external changes from the reconciler. Strategies see the unified stream.
    this.opts.portfolio.on('change', (c: unknown) =>
      this.dispatchPositionChange(c as PositionChange),
    );

    this.tickTimer = setInterval(() => {
      this.dispatchTick();
    }, this.tickIntervalMs);
  }

  /**
   * Stop accepting new dispatches: clear the tick interval and unsubscribe
   * from the signal queue. In-flight queue tasks are NOT drained; callers
   * can await pending queue chains if a clean shutdown is needed.
   */
  stop(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.opts.signalQueue.unsubscribe(this.signalSubName);
  }

  /** Pause an instance — subsequent dispatches are skipped until resumed. */
  pause(instanceId: string): void {
    const rec = this.instances.get(instanceId);
    if (rec) rec.quarantined = true;
  }

  /** Resume a paused instance. */
  resume(instanceId: string): void {
    const rec = this.instances.get(instanceId);
    if (rec) rec.quarantined = false;
  }

  // ---------------------------------------------------------------------------
  // Dispatch methods
  // ---------------------------------------------------------------------------

  private dispatchSignal(sig: Signal): void {
    for (const rec of this.instances.values()) {
      if (rec.quarantined) continue;
      if (!matchesAny(rec.strategy.filters, sig)) continue;

      // Advisor note 4 / gate-6 determinism: the ENTIRE callback —
      // onSignal + guard check + executor.submit + adapt + applyLandedTrade —
      // runs inside the per-instance queue. This serialises submit alongside
      // hook calls so two signals for the same instance can never interleave,
      // preventing concurrent intentId collisions or out-of-order portfolio
      // mutations.
      void rec.queue.enqueue(async () => {
        const decision = await this.callHook(rec, 'onSignal', () =>
          rec.strategy.onSignal(sig, rec.ctx),
        );
        if (decision == null) return;

        // Guard: record this decision; trip if over rate limit
        const trip = rec.guards.recordDecision();
        if (trip) {
          void this.tripGuard(rec, trip);
          return;
        }

        // Derive a deterministic intentId from the (signal, strategy, instance) quad
        const iId = intentId({
          signalId: sig.signalId,
          strategyName: rec.strategy.name,
          instanceId: rec.instanceId,
        });
        const fullIntent: TradeIntent = { ...decision, intentId: iId };

        // Resolve wallet address — cached on first lookup (addresses are immutable)
        let walletAddress = rec.walletAddresses.get(fullIntent.wallet);
        if (walletAddress === undefined) {
          walletAddress = await rec.ctx.vault.getAddress(fullIntent.wallet);
          rec.walletAddresses.set(fullIntent.wallet, walletAddress);
        }

        // C2 carryover: executor.submit runs INSIDE this queue callback
        const result = await this.opts.executor.submit(fullIntent);

        // C3 carryover: adaptToLandedTrades returns [] for timeout/dropped/reverted/rejected
        const trades = await adaptToLandedTrades(result, {
          rpcPool: this.opts.rpcPool,
          walletAddress,
        });

        for (const trade of trades) {
          await this.opts.portfolio.applyLandedTrade(trade);
        }
      });
    }
  }

  private dispatchExecutionResult(result: ExecutionResult): void {
    for (const rec of this.instances.values()) {
      if (rec.quarantined || !rec.strategy.onExecutionResult) continue;
      void rec.queue.enqueue(() =>
        this.callHook(rec, 'onExecutionResult', () =>
          rec.strategy.onExecutionResult!(result, rec.ctx),
        ),
      );
    }
  }

  private dispatchPositionChange(change: PositionChange): void {
    for (const rec of this.instances.values()) {
      if (rec.quarantined || !rec.strategy.onPositionChange) continue;
      void rec.queue.enqueue(() =>
        this.callHook(rec, 'onPositionChange', () =>
          rec.strategy.onPositionChange!(change, rec.ctx),
        ),
      );
    }
  }

  private dispatchTick(): void {
    const now = this.clock();
    for (const rec of this.instances.values()) {
      if (rec.quarantined || !rec.strategy.onTick) continue;
      void rec.queue.enqueue(() =>
        this.callHook(rec, 'onTick', () => rec.strategy.onTick!(now, rec.ctx)),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // callHook — error isolation wrapper
  // ---------------------------------------------------------------------------

  /**
   * Wraps a hook call in try/catch.
   *
   * On error:
   *   1. Calls `strategy.onError` synchronously (swallows any error it throws).
   *   2. Records the error in the guard tracker; trips if over the threshold.
   *   3. Emits a 'strategy-error' event on the runtime.
   *
   * Returns the hook's value or `undefined` on error.
   */
  private async callHook<T>(
    rec: InstanceRecord,
    phase: HookPhase,
    fn: () => Promise<T> | T,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      // onError is a synchronous void reporter — wrap in try/catch so a
      // throwing reporter never breaks our internal error path.
      try {
        rec.strategy.onError?.(err as Error, phase, rec.ctx);
      } catch {
        /* swallow — reporter must not propagate */
      }

      const trip = rec.guards.recordError();
      if (trip) {
        void this.tripGuard(rec, trip);
      }

      this.emit('strategy-error', { instanceId: rec.instanceId, phase, error: err });
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // tripGuard — idempotent quarantine
  // ---------------------------------------------------------------------------

  /**
   * Quarantine an instance that has tripped a guard.
   *
   * Idempotent: if the instance is already quarantined this is a no-op.
   * Does NOT deregister — the instance remains in the map so telemetry can
   * attribute subsequent "dropped: quarantined" dispatches to it.
   */
  private async tripGuard(rec: InstanceRecord, trip: GuardTrip): Promise<void> {
    if (rec.quarantined) return;
    rec.quarantined = true;

    this.metrics.emit('strategy.tripped', {
      instanceId: rec.instanceId,
      guard: trip.guard,
      value: trip.value,
    });

    if (rec.strategy.onShutdown) {
      try {
        await rec.strategy.onShutdown(rec.ctx);
      } catch {
        /* swallow — shutdown errors must not propagate from tripGuard */
      }
    }
  }
}
