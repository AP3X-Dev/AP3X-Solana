import type { SwapIntent } from './intents.js';
import { swapIntentIdempotencyKey } from './intents.js';

export interface Instruction {
  readonly programId: unknown;
  readonly accounts: ReadonlyArray<{ readonly pubkey: unknown; readonly isSigner: boolean; readonly isWritable: boolean }>;
  readonly data: Uint8Array;
}

export type FeeTier = 'low' | 'med' | 'high' | 'turbo';

export interface SubmitterHint {
  readonly kind: 'rpc' | 'jito-http' | 'jito-grpc';
  readonly bundleGroup?: string;
}

export interface InstructionLevelTradeIntent {
  readonly intentId: string;
  readonly wallet: string;
  readonly instructions: Instruction[];
  readonly altHints?: unknown[];
  readonly feeTier: FeeTier;
  readonly computeBudgetHint?: number;
  readonly deadline: number;
  readonly submitter?: SubmitterHint;
  readonly retry?: { readonly maxAttempts?: number; readonly bumpProgression?: boolean };
}

export interface ToExecutorTradeIntentInput {
  readonly intent: SwapIntent;
  readonly wallet: string;
  readonly instructions: readonly Instruction[];
  readonly feeTier: FeeTier;
  readonly deadline: number;
  readonly intentId?: string;
  readonly altHints?: readonly unknown[];
  readonly computeBudgetHint?: number;
  readonly submitter?: SubmitterHint;
  readonly retry?: InstructionLevelTradeIntent['retry'];
}

/**
 * Adapt a high-level swap intent to the instruction-level executor contract.
 *
 * The caller still owns quote selection and transaction instruction building.
 * This helper preserves the high-level intent idempotency key as the executor
 * `intentId`, unless an explicit override is supplied.
 */
export function toExecutorTradeIntent(input: ToExecutorTradeIntentInput): InstructionLevelTradeIntent {
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
