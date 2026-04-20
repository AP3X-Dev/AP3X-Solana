/**
 * `Executor` — the single entry point a strategy calls to turn a
 * {@link TradeIntent} into an on-chain outcome.
 *
 * Responsibilities (spec §3.3):
 *   1. Idempotency — duplicate `intentId`s share one {@link InFlightMap} slot.
 *   2. Wallet resolution — map `intent.wallet` to a live {@link WalletHandle}.
 *      Vault access is passphrase-gated, so callers inject a resolver; the
 *      executor never owns passphrases itself.
 *   3. Budget + fee telemetry — simulate for a compute-unit estimate and
 *      resolve the priority-fee tier. In PRP-02 the numbers are emitted as
 *      events; the actual `ComputeBudget::SetComputeUnitLimit` /
 *      `SetComputeUnitPrice` ix prepending is the strategy's job in PRP-03.
 *   4. Assembly + signing — call {@link assemble} with the handle as the
 *      signer. WalletHandle satisfies the `Signer` interface directly.
 *   5. Routing — pick a submitter honouring `intent.submitter.kind` and the
 *      configured fallback chain. Bundle intents route through the
 *      {@link BundleAccumulator}; single-tx intents call `submitter.submit`.
 *   6. Landing confirmation — poll signatures via {@link confirmLanded} and
 *      emit a structured {@link ExecutionResult}.
 *
 * Advisor note 1 — ConfigError hoist. Bundle-group intents require a Jito
 * submitter. We validate this BEFORE entering `inFlight.run`, so the rejection
 * is synchronous at the API boundary and duplicate rejected intents don't
 * poison the in-flight slot. The uniform envelope is the
 * {@link ExecutionResult} `{ kind: 'rejected' }` shape — the Executor never
 * throws for user-visible failure modes.
 *
 * Advisor note 2 — Vault API. `@ap3x/solana-vault`'s only entry point is
 * `vault.unlock(name, passphrase, options?)`. Passphrases are not part of the
 * trade intent contract and the executor must not prompt or cache them.
 * Instead, callers pass `resolveWallet(name): Promise<WalletHandle>`, which
 * is the seam that upstream code (CLI, service boot, test harness) uses to
 * wire unlocked handles in. If resolution throws we surface
 * `{ kind: 'rejected', error: { code: 'wallet_locked' } }`.
 */

import { EventEmitter } from 'node:events';

import type { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import {
  assemble as defaultAssemble,
  simulateAndBudget as defaultSimulateAndBudget,
  type AssemblerOptions,
  type AssemblerResult,
  type Instruction as TxInstruction,
  type RpcPoolLike,
  type SimulateResult,
} from '@ap3x/solana-tx';
import { WalletReserveBreach, type WalletHandle } from '@ap3x/solana-vault';

import { BundleAccumulator } from './bundle-accumulator.js';
import { confirmLanded } from './confirm-landed.js';
import { InFlightMap } from './in-flight.js';
import type { SubmissionAck, Submitter } from './submitter.js';
import type {
  ExecutionResult,
  FeeTier,
  Instruction as ExecutorInstruction,
  TradeIntent,
} from './types.js';

/**
 * Fee-tier progression used by the retry loop when
 * `intent.retry.bumpProgression === true`. Each dropped/timeout/transient
 * failure advances one step up this ladder; past `turbo` the tier stops
 * climbing and retries re-submit at the top of the progression.
 */
export const BUMP_PROGRESSION: FeeTier[] = ['low', 'med', 'high', 'turbo'];

/**
 * Minimum {@link PriorityFeeEstimator} surface we consume — typed as the
 * public method only so tests can pass a bare `{ tier(t) }` stub without
 * constructing a real Geyser-backed estimator.
 */
export interface FeeEstimatorLike {
  tier(t: TradeIntent['feeTier']): number;
}

/**
 * Pluggable assembler — defaults to {@link defaultAssemble}. Parameterised so
 * tests can inject a fake that returns a deterministic byte buffer without
 * going through the full v0 message compiler.
 */
export type AssembleFn = (options: AssemblerOptions) => Promise<AssemblerResult>;

/**
 * Pluggable simulate helper — defaults to {@link defaultSimulateAndBudget}.
 * Never throws: we rely on the helper's own fallback behaviour so a dead
 * simulator can't block intent execution.
 */
export type SimulateAndBudgetFn = (
  rpcPool: RpcPoolLike,
  txBase64: string,
  payer: PublicKey,
) => Promise<SimulateResult>;

export interface ExecutorOpts {
  rpcPool: RpcPool;
  feeEstimator: FeeEstimatorLike;
  /**
   * Return an unlocked {@link WalletHandle} for the given wallet name. Upstream
   * code owns passphrase resolution; the executor never prompts. A throw is
   * surfaced as `ExecutionResult { kind: 'rejected', error.code: 'wallet_locked' }`.
   */
  resolveWallet: (name: string) => Promise<WalletHandle>;
  submitters: Submitter[];
  defaultSubmitter: 'rpc' | 'jito-http' | 'jito-grpc';
  fallbackChain?: Array<'jito-grpc' | 'jito-http' | 'rpc'>;
  bundleWindowMs?: number;
  bundleMaxIntents?: number;
  pollIntervalMs?: number;
  /** Injection seams for tests. */
  assemble?: AssembleFn;
  simulateAndBudget?: SimulateAndBudgetFn;
}

/**
 * Resolved options with defaults applied. We keep the concrete shape as the
 * class's private `opts` so every branch below can access defaults without
 * `??` ladders everywhere.
 */
interface ResolvedOpts extends Required<Omit<ExecutorOpts, 'assemble' | 'simulateAndBudget'>> {
  assemble: AssembleFn;
  simulateAndBudget: SimulateAndBudgetFn;
}

/** Events emitted over the {@link EventEmitter} surface. */
export interface ExecutorEvents {
  result: (r: ExecutionResult) => void;
  'budget-fallback': (evt: { intentId: string; reason: string }) => void;
  'fee-tier': (evt: { intentId: string; tier: TradeIntent['feeTier']; microLamportsPerCu: number }) => void;
  /**
   * Fired at the start of every execution attempt — 1-indexed. Emitted before
   * wallet resolution / assembly / submission, so a correlated log/metric
   * pipeline sees one `executor.attempt` per retry irrespective of which
   * phase the previous attempt failed in.
   */
  'executor.attempt': (evt: { intentId: string; attempt: number; feeTier: FeeTier }) => void;
}

export class Executor extends EventEmitter {
  readonly #inFlight = new InFlightMap<ExecutionResult>();
  readonly #bundleAcc: BundleAccumulator;
  readonly #opts: ResolvedOpts;

  constructor(opts: ExecutorOpts) {
    super();
    this.#opts = {
      rpcPool: opts.rpcPool,
      feeEstimator: opts.feeEstimator,
      resolveWallet: opts.resolveWallet,
      submitters: opts.submitters,
      defaultSubmitter: opts.defaultSubmitter,
      fallbackChain: opts.fallbackChain ?? ['jito-grpc', 'jito-http', 'rpc'],
      bundleWindowMs: opts.bundleWindowMs ?? 50,
      bundleMaxIntents: opts.bundleMaxIntents ?? 5,
      pollIntervalMs: opts.pollIntervalMs ?? 250,
      assemble: opts.assemble ?? defaultAssemble,
      simulateAndBudget: opts.simulateAndBudget ?? defaultSimulateAndBudget,
    };
    this.#bundleAcc = new BundleAccumulator({
      windowMs: this.#opts.bundleWindowMs,
      maxPerBundle: this.#opts.bundleMaxIntents,
      onFlush: (entries) => this.#flushBundle(entries),
    });
  }

  /**
   * Submit an intent. Returns the terminal {@link ExecutionResult} —
   * `landed`, `reverted`, `timeout`, `dropped`, or `rejected`. Duplicate
   * `intentId`s share a single in-flight slot and receive the same resolution.
   *
   * Advisor note 1: the bundle/no-Jito-submitter validation fires BEFORE
   * `inFlight.run`, so a misconfigured caller gets a synchronous rejection
   * at the API boundary without poisoning the in-flight map.
   *
   * Retry semantics (`intent.retry`):
   *   - `maxAttempts` (default 1) — total number of attempts including the
   *     first. `0` is normalised to `1` — `submit` never executes zero times.
   *   - `bumpProgression` (default false) — when true, each retry advances
   *     the fee tier per {@link BUMP_PROGRESSION}; at `turbo` the tier
   *     plateaus. When false, retries re-execute at the caller's tier
   *     (useful for transient RPC failover).
   *
   * Retryable results: `timeout` (deadline-based drop from
   * {@link confirmLanded}), `dropped`, and `rejected` with a transient code
   * (`submit_failed`, `blockhash_fetch_failed`, `bundle_flush_failed`,
   * `no_submitter`). Terminal results that short-circuit the loop:
   * `landed`, `reverted`, and `rejected` with `reserve_breach`, `sign_failed`,
   * `wallet_locked`, or `no_jito_submitter_for_bundle`.
   *
   * The retry loop lives INSIDE `inFlight.run` — a duplicate `intentId`
   * attaches to the existing slot and shares the final result after all
   * retries complete, rather than kicking off a parallel retry cycle.
   */
  async submit(intent: TradeIntent): Promise<ExecutionResult> {
    if (intent.submitter?.bundleGroup !== undefined) {
      const hasJito = this.#opts.submitters.some(
        (s) =>
          (s.kind === 'jito-http' || s.kind === 'jito-grpc') &&
          s.health().state !== 'unhealthy',
      );
      if (!hasJito) {
        return this.#rejected(
          intent,
          undefined,
          'no_jito_submitter_for_bundle',
          'bundleGroup requires a healthy Jito submitter; none configured',
        );
      }
    }
    return this.#inFlight.run(intent.intentId, () => this.#runWithRetry(intent));
  }

  /**
   * Drive the retry loop around {@link #execute}. Emits `executor.attempt`
   * for every attempt (1-indexed) and returns the first terminal result —
   * either a short-circuit (landed/reverted/reserve_breach) or the final
   * attempt's result when retries are exhausted.
   */
  async #runWithRetry(intent: TradeIntent): Promise<ExecutionResult> {
    const rawMax = intent.retry?.maxAttempts ?? 1;
    // Normalise 0 / undefined / negative to 1 — `submit` never runs 0 times.
    const maxAttempts = rawMax > 0 ? rawMax : 1;
    const bumpProgression = intent.retry?.bumpProgression ?? false;

    let currentTier: FeeTier = intent.feeTier;
    let lastResult: ExecutionResult | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.emit('executor.attempt', {
        intentId: intent.intentId,
        attempt,
        feeTier: currentTier,
      });

      const attemptIntent: TradeIntent = { ...intent, feeTier: currentTier };
      const result = await this.#execute(attemptIntent);
      lastResult = result;

      if (isTerminalResult(result)) return result;

      // Retryable — bump tier for the next attempt when progression is on.
      if (bumpProgression && attempt < maxAttempts) {
        const idx = BUMP_PROGRESSION.indexOf(currentTier);
        if (idx >= 0 && idx < BUMP_PROGRESSION.length - 1) {
          currentTier = BUMP_PROGRESSION[idx + 1]!;
        }
        // If we're already at the top of the progression (or the starting tier
        // wasn't in the ladder), we plateau — retries keep the same tier.
      }
    }

    // `lastResult` is defined: the loop runs at least once (maxAttempts >= 1).
    return lastResult!;
  }

  // ---- private ----------------------------------------------------------

  async #execute(intent: TradeIntent): Promise<ExecutionResult> {
    // --- 1. Wallet resolution -------------------------------------------
    let handle: WalletHandle;
    try {
      handle = await this.#opts.resolveWallet(intent.wallet);
    } catch (err: unknown) {
      return this.#rejected(
        intent,
        undefined,
        'wallet_locked',
        err instanceof Error ? err.message : String(err),
      );
    }

    // --- 2. Fee tier (telemetry) ----------------------------------------
    const microLamportsPerCu = this.#opts.feeEstimator.tier(intent.feeTier);
    this.emit('fee-tier', {
      intentId: intent.intentId,
      tier: intent.feeTier,
      microLamportsPerCu,
    });

    // --- 3. Recent blockhash --------------------------------------------
    let recentBlockhash: string;
    try {
      const resp = (await this.#opts.rpcPool.call('getLatestBlockhash', [])) as {
        value: { blockhash: string };
      };
      recentBlockhash = resp.value.blockhash;
    } catch (err: unknown) {
      return this.#rejected(
        intent,
        undefined,
        'blockhash_fetch_failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    // --- 4. Assemble + sign ---------------------------------------------
    const txInstructions: TxInstruction[] = intent.instructions.map(adaptInstruction);
    let signedTx: Uint8Array;
    try {
      // PRP-03 wires ALT lookups; `intent.altHints` is reserved for then. We
      // omit `alts` entirely rather than pass `undefined`, because the
      // assembler's `AssemblerOptions` uses `exactOptionalPropertyTypes`.
      const result = await this.#opts.assemble({
        instructions: txInstructions,
        payer: handle.address,
        signers: [handle],
        recentBlockhash,
      });
      signedTx = result.signedTransaction;
    } catch (err: unknown) {
      if (err instanceof WalletReserveBreach) {
        return this.#rejected(intent, undefined, 'reserve_breach', err.message);
      }
      return this.#rejected(
        intent,
        undefined,
        'sign_failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    // --- 5. Budget simulation (telemetry — non-fatal) -------------------
    // `simulateAndBudget` never throws; on failure it falls back internally
    // and emits a `compute-budget-fallback` metric of its own. We emit a
    // local event when that fallback path kicks in by comparing against the
    // documented fallback constant pair.
    void this.#emitBudgetTelemetry(intent, signedTx, handle.address);

    // --- 6. Routing ------------------------------------------------------
    const submitter = this.#pickSubmitter(intent);
    if (!submitter) {
      return this.#rejected(
        intent,
        undefined,
        'no_submitter',
        'no healthy submitter for requested kind',
      );
    }

    // --- 7. Bundle path -------------------------------------------------
    // Advisor note 1 continuation: the hoisted check already ruled out the
    // "no Jito submitter" case, so we only reach here with a live bundler.
    if (intent.submitter?.bundleGroup !== undefined) {
      let signature: string;
      try {
        signature = await this.#bundleAcc.add(intent.submitter.bundleGroup, { signedTx });
      } catch (err: unknown) {
        return this.#rejected(
          intent,
          submitter.name,
          'bundle_flush_failed',
          err instanceof Error ? err.message : String(err),
        );
      }
      return this.#confirm(intent, signature, submitter.name);
    }

    // --- 8. Single-tx path ----------------------------------------------
    let ack: SubmissionAck;
    try {
      ack = await submitter.submit({ kind: 'tx', signedTx });
    } catch (err: unknown) {
      return this.#rejected(
        intent,
        submitter.name,
        'submit_failed',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!ack.signature) {
      return this.#rejected(
        intent,
        submitter.name,
        'submit_failed',
        'submitter returned no signature for tx payload',
      );
    }
    return this.#confirm(intent, ack.signature, submitter.name);
  }

  async #confirm(
    intent: TradeIntent,
    signature: string,
    submitterUsed: string,
  ): Promise<ExecutionResult> {
    const result = await confirmLanded({
      rpcPool: this.#opts.rpcPool,
      signature,
      deadline: intent.deadline,
      pollIntervalMs: this.#opts.pollIntervalMs,
    });
    let final: ExecutionResult;
    if (result.kind === 'landed') {
      final = {
        kind: 'landed',
        intentId: intent.intentId,
        signature,
        slot: result.slot,
        submitterUsed,
        landedAt: result.landedAt,
      };
    } else if (result.kind === 'reverted') {
      final = {
        kind: 'reverted',
        intentId: intent.intentId,
        signature,
        slot: result.slot,
        submitterUsed,
        logs: result.logs,
        error: result.error,
      };
    } else {
      final = { kind: 'timeout', intentId: intent.intentId, signature, submitterUsed };
    }
    this.emit('result', final);
    return final;
  }

  #rejected(
    intent: TradeIntent,
    submitterUsed: string | undefined,
    code: string,
    message: string,
  ): ExecutionResult {
    const r: ExecutionResult = {
      kind: 'rejected',
      intentId: intent.intentId,
      error: { code, message },
      ...(submitterUsed !== undefined ? { submitterUsed } : {}),
    };
    this.emit('result', r);
    return r;
  }

  #pickSubmitter(intent: TradeIntent): Submitter | null {
    const wantedKind = intent.submitter?.kind ?? this.#opts.defaultSubmitter;
    const ordered: string[] = [
      wantedKind,
      ...this.#opts.fallbackChain.filter((k) => k !== wantedKind),
    ];
    for (const kind of ordered) {
      const candidate = this.#opts.submitters.find(
        (s) => s.kind === kind && s.health().state !== 'unhealthy',
      );
      if (candidate) return candidate;
    }
    return null;
  }

  #emitBudgetTelemetry(
    intent: TradeIntent,
    signedTx: Uint8Array,
    payer: PublicKey,
  ): void {
    // Run asynchronously — simulation is informational in PRP-02 and must not
    // gate the critical path. We catch just in case a future
    // `simulateAndBudget` implementation loses its never-throws contract.
    void (async () => {
      try {
        const txBase64 = Buffer.from(signedTx).toString('base64');
        const sim = await this.#opts.simulateAndBudget(this.#opts.rpcPool, txBase64, payer);
        // `SimulateResult` is `{ unitsConsumed, unitsLimit }`. When the helper
        // falls back, `unitsConsumed === FALLBACK_UNITS_CONSUMED` (200_000) —
        // we surface a local event so downstream can correlate with the
        // metric the helper also emits.
        if (sim.unitsConsumed === 200_000 && sim.unitsLimit === 230_000) {
          this.emit('budget-fallback', {
            intentId: intent.intentId,
            reason: 'simulateAndBudget fell back to conservative default',
          });
        }
      } catch (err: unknown) {
        this.emit('budget-fallback', {
          intentId: intent.intentId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  async #flushBundle(entries: { signedTx: Uint8Array }[]): Promise<string[]> {
    const sub = this.#opts.submitters.find(
      (s) =>
        (s.kind === 'jito-grpc' || s.kind === 'jito-http') &&
        s.health().state !== 'unhealthy',
    );
    if (!sub) {
      throw new Error('no healthy Jito submitter configured for bundle flush');
    }
    const ack = await sub.submit({
      kind: 'bundle',
      signedTxs: entries.map((e) => e.signedTx),
      tipLamports: 10_000n,
    });
    const bundleId = ack.bundleId ?? 'unknown';
    // BundleAccumulator resolves each intent with a per-entry string. Jito
    // acks the whole bundle with a single `bundleId` — we synthesize
    // per-entry identifiers by appending the entry index. Confirmation polls
    // signatures directly (via `confirmLanded`) using these placeholders;
    // PRP-03 will thread real signature recovery when intents need to be
    // distinguished inside a bundle.
    return entries.map((_, i) => `${bundleId}-${i}`);
  }
}

/**
 * Adapt the executor's local {@link ExecutorInstruction} shape (`{ accounts }`)
 * to the assembler's {@link TxInstruction} shape (`{ keys }`). Both represent
 * the same thing — the field rename is historical across the two packages.
 */
function adaptInstruction(ix: ExecutorInstruction): TxInstruction {
  return {
    programId: ix.programId,
    keys: ix.accounts,
    data: ix.data,
  };
}

/**
 * `rejected` error codes that represent a permanent, non-retryable failure.
 * Anything else in the rejected branch is treated as transient (e.g. RPC
 * hiccup, blockhash service flap, submitter fault) and the retry loop will
 * re-execute the intent.
 */
const TERMINAL_REJECT_CODES: ReadonlySet<string> = new Set([
  'reserve_breach',
  'sign_failed',
  'wallet_locked',
  'no_jito_submitter_for_bundle',
]);

/**
 * A result is terminal — i.e. the retry loop stops — when it's either
 * a successful on-chain outcome (landed / reverted), or a `rejected` with
 * a permanent error code. `timeout`, `dropped`, and transient rejections
 * are retryable.
 */
function isTerminalResult(r: ExecutionResult): boolean {
  if (r.kind === 'landed' || r.kind === 'reverted') return true;
  if (r.kind === 'rejected') return TERMINAL_REJECT_CODES.has(r.error.code);
  return false;
}
