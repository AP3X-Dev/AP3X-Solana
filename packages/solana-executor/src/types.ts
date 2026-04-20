import type { PublicKey } from '@ap3x/solana-core';

export interface Instruction {
  programId: PublicKey;
  accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
}

export type FeeTier = 'low' | 'med' | 'high' | 'turbo';

export interface SubmitterHint {
  kind: 'rpc' | 'jito-http' | 'jito-grpc';
  bundleGroup?: string;
}

export interface TradeIntent {
  intentId: string;
  wallet: string;
  instructions: Instruction[];
  altHints?: PublicKey[];
  feeTier: FeeTier;
  computeBudgetHint?: number;
  deadline: number;
  submitter?: SubmitterHint;
  retry?: { maxAttempts?: number; bumpProgression?: boolean };
}

export type ExecutionResult =
  | { kind: 'landed'; intentId: string; signature: string; slot: number; submitterUsed: string; landedAt: number }
  | { kind: 'dropped'; intentId: string; signature?: string; submitterUsed: string; lastSeenSlot?: number }
  | { kind: 'timeout'; intentId: string; signature?: string; submitterUsed: string }
  | { kind: 'reverted'; intentId: string; signature: string; slot: number; submitterUsed: string; logs: string[]; error: string }
  | { kind: 'rejected'; intentId: string; submitterUsed?: string; error: { code: string; message: string; meta?: Record<string, unknown> } };
