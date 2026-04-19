/**
 * `simulateAndBudget` — estimate the compute-unit budget for a serialised v0
 * transaction by round-tripping through an RPC `simulateTransaction` call.
 *
 * This is the PRP-01 stub. It returns a `{ unitsConsumed, unitsLimit }`
 * pair where `unitsLimit = ceil(unitsConsumed * 1.15)` — a flat 15% headroom
 * on top of the simulator's observation. That constant covers typical
 * inter-slot state drift (account lamport movements, sysvar clock bumps)
 * without being so generous that we bid away priority-fee headroom on the
 * average tx. PRP-03 will layer error-class-specific budgeting on top of
 * this — e.g. widening the headroom after an `ExceededMaxComputeUnits`
 * signal, or tightening it on an idle leader.
 *
 * Error handling is deliberately coarse: any RPC failure OR simulation
 * error (non-null `value.err` in the response) falls back to a conservative
 * `{ unitsConsumed: 200_000, unitsLimit: 230_000 }`. 200k CU is roughly
 * twice the typical Jupiter-swap or pump.fun trade cost, and 230k leaves a
 * 15% buffer over that baseline. The fallback emits a single
 * `compute-budget-fallback` metric so operators can alert when simulation
 * reliability degrades.
 *
 * Metrics event shape:
 *
 *     {
 *       package: '@ap3x/solana-tx',
 *       op: 'compute-budget-fallback',
 *       meta: {
 *         reason: <stringified error or sim-err>,
 *         note: 'PRP-01 stub — PRP-03 will flesh out error-class handling',
 *       },
 *     }
 *
 * Inputs:
 *   - `rpcPool` — any object with a compatible `call(method, params)` surface.
 *     In production this is `@ap3x/solana-connectivity`'s `RpcPool`.
 *   - `txBase64` — the v0 tx bytes, base64-encoded.
 *   - `payer`    — the fee-payer pubkey. Reserved for future extensions
 *     (e.g. simulating against the payer's live account state); the
 *     simulator itself doesn't need it because `replaceRecentBlockhash`
 *     handles the transient-account-validity concerns.
 */

import { emitMetric, type PublicKey } from '@ap3x/solana-core';

/** Fallback compute-units estimate when simulation is unavailable. */
export const FALLBACK_UNITS_CONSUMED = 200_000;

/** Matching fallback limit — `ceil(FALLBACK_UNITS_CONSUMED * 1.15)`. */
export const FALLBACK_UNITS_LIMIT = 230_000;

/** Headroom multiplier applied to simulator output. */
export const BUDGET_HEADROOM = 1.15;

/** A note stamped onto every fallback metric for downstream attribution. */
const FALLBACK_NOTE =
  'PRP-01 stub — PRP-03 will flesh out error-class handling';

/**
 * Result shape. `unitsConsumed` is the raw observation from the simulator;
 * `unitsLimit` is what the caller should install into a
 * `ComputeBudgetInstruction::SetComputeUnitLimit`. Keeping both makes it
 * easy for downstream telemetry to track the gap between observation and
 * budget over time.
 */
export interface SimulateResult {
  unitsConsumed: number;
  unitsLimit: number;
}

/**
 * Minimum RpcPool surface we need — abstracted so tests can stub without
 * importing the real pool. The real `RpcPool.call` is a generic overload;
 * this narrower signature is assignment-compatible.
 */
export interface RpcPoolLike {
  call(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown>;
}

/**
 * Run the simulator and return a budget. Never throws — on any error it
 * emits a metric and falls back to the conservative baseline.
 */
export async function simulateAndBudget(
  rpcPool: RpcPoolLike,
  txBase64: string,
  // `payer` is parked for future use; dropping it from the signature now
  // would force a breaking change for PRP-03 callers who will want it.
  payer: PublicKey,
): Promise<SimulateResult> {
  // Mark `payer` as intentionally-unused at the type level without tripping
  // lint. Referencing it in a truthy void cast keeps the param live.
  void payer;

  try {
    const result = await rpcPool.call('simulateTransaction', [
      txBase64,
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
      },
    ]);

    const valueContainer =
      typeof result === 'object' && result !== null
        ? (result as { value?: unknown }).value
        : undefined;
    const value =
      typeof valueContainer === 'object' && valueContainer !== null
        ? (valueContainer as {
            err?: unknown;
            unitsConsumed?: number;
          })
        : undefined;

    if (!value) {
      return fallback(`unexpected response shape — value missing`);
    }
    if (value.err != null) {
      return fallback(`simulation error: ${safeStringify(value.err)}`);
    }

    const unitsConsumed =
      typeof value.unitsConsumed === 'number' && Number.isFinite(value.unitsConsumed)
        ? Math.max(0, value.unitsConsumed)
        : FALLBACK_UNITS_CONSUMED;
    const unitsLimit = Math.ceil(unitsConsumed * BUDGET_HEADROOM);
    return { unitsConsumed, unitsLimit };
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : safeStringify(e);
    return fallback(reason);
  }
}

/**
 * Build the conservative fallback budget and emit the telemetry event that
 * flags this code path as a degraded operation. Kept as a helper so the
 * two call sites (simulation error + thrown exception) can't diverge on
 * the constants they publish.
 */
function fallback(reason: string): SimulateResult {
  emitMetric({
    package: '@ap3x/solana-tx',
    op: 'compute-budget-fallback',
    meta: { reason, note: FALLBACK_NOTE },
  });
  return {
    unitsConsumed: FALLBACK_UNITS_CONSUMED,
    unitsLimit: FALLBACK_UNITS_LIMIT,
  };
}

/**
 * JSON.stringify that never throws. `value.err` is typically a plain
 * object (`{ InstructionError: [0, "..."] }`) but can be a primitive or
 * a cyclic structure depending on the provider — wrap defensively.
 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
