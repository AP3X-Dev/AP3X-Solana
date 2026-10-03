/**
 * Compute Budget program instructions: the unit limit and the priority fee
 * price, both set ahead of a transaction's other instructions.
 *
 *   SetComputeUnitLimit  data = [2][units: u32 LE]
 *   SetComputeUnitPrice  data = [3][microLamports: u64 LE]
 */

import { PublicKey } from '@ap3x/solana-core';

import { TransactionError } from './transaction-assembler';
import type { Instruction } from './transaction-assembler';

export const COMPUTE_BUDGET_PROGRAM_ID: PublicKey = PublicKey.fromBase58('ComputeBudget111111111111111111111111111111');

const SET_UNIT_LIMIT = 2;
const SET_UNIT_PRICE = 3;
/** Runtime ceiling per transaction. */
export const MAX_COMPUTE_UNITS = 1_400_000;
const U64_MAX = (1n << 64n) - 1n;

export function setComputeUnitLimit(units: number): Instruction {
  if (!Number.isInteger(units) || units <= 0 || units > MAX_COMPUTE_UNITS) {
    throw new TransactionError('invalid_compute_budget', `compute unit limit must be 1..${MAX_COMPUTE_UNITS} (got ${units})`);
  }
  const data = new Uint8Array(5);
  data[0] = SET_UNIT_LIMIT;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data };
}

/** Priority fee price in micro-lamports per compute unit. */
export function setComputeUnitPrice(microLamports: bigint): Instruction {
  if (microLamports < 0n || microLamports > U64_MAX) {
    throw new TransactionError('invalid_compute_budget', `compute unit price out of range (got ${microLamports})`);
  }
  const data = new Uint8Array(9);
  data[0] = SET_UNIT_PRICE;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data };
}
