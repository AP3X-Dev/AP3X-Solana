import type { FeeTier, Instruction, SubmitterHint, TradeIntent } from '@ap3x/solana-executor';
import type { SwapIntent } from './intents.js';
import { swapIntentIdempotencyKey } from './intents.js';

/**
 * Bridge from a venue-agnostic {@link SwapIntent} to the executor's
 * instruction-level {@link TradeIntent}. The executor's own types are used
 * directly, so the result is passed to `Executor.submit` as-is.
 */

export type { FeeTier, Instruction, SubmitterHint };
/** The executor's intent type (kept under its earlier name here). */
export type InstructionLevelTradeIntent = TradeIntent;

export interface ToExecutorTradeIntentInput {
  readonly intent: SwapIntent;
  readonly wallet: string;
  readonly instructions: readonly Instruction[];
  readonly feeTier: FeeTier;
  readonly deadline: number;
  readonly intentId?: string;
  readonly altHints?: TradeIntent['altHints'];
  readonly computeBudgetHint?: number;
  readonly submitter?: SubmitterHint;
  readonly retry?: TradeIntent['retry'];
}

/**
 * Adapt a high-level swap intent to the instruction-level executor contract.
 *
 * The caller still owns quote selection and transaction instruction building.
 * This helper preserves the high-level intent idempotency key as the executor
 * `intentId`, unless an explicit override is supplied.
 */
export function toExecutorTradeIntent(input: ToExecutorTradeIntentInput): TradeIntent {
  return {
    intentId: input.intentId ?? swapIntentIdempotencyKey(input.intent),
    wallet: input.wallet,
    instructions: input.instructions.map((ix) => ({
      programId: ix.programId,
      accounts: [...ix.accounts],
      data: new Uint8Array(ix.data),
    })),
    feeTier: input.feeTier,
    deadline: input.deadline,
    ...(input.altHints !== undefined ? { altHints: [...input.altHints] } : {}),
    ...(input.computeBudgetHint !== undefined ? { computeBudgetHint: input.computeBudgetHint } : {}),
    ...(input.submitter !== undefined ? { submitter: input.submitter } : {}),
    ...(input.retry !== undefined ? { retry: input.retry } : {}),
  };
}
