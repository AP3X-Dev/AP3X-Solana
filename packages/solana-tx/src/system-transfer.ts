/**
 * SystemProgram `Transfer`: build one, and recognise one inside an
 * instruction list.
 *
 *   data = [discriminator: u32 LE = 2 (Transfer)][lamports: u64 LE]   (12 bytes)
 *   keys = [from: signer + writable, to: writable]
 *
 * The parser is strict on purpose: callers use it to check that a built or
 * signed transaction pays exactly what it should, so anything that is not a
 * well-formed transfer returns `null` instead of a best guess.
 */

import { PublicKey } from '@ap3x/solana-core';

import { TransactionError } from './transaction-assembler';
import type { Instruction } from './transaction-assembler';

/** SystemProgram: 32 zero bytes, `11111111111111111111111111111111`. */
export const SYSTEM_PROGRAM_ID: PublicKey = PublicKey.fromBytes(new Uint8Array(32));

const TRANSFER = 2;
const DATA_LENGTH = 12;
const U64_MAX = (1n << 64n) - 1n;

export interface SystemTransfer {
  from: PublicKey;
  to: PublicKey;
  lamports: bigint;
}

/** @throws {@link TransactionError} (`tx.invalid_transfer`) unless `0 < lamports <= u64::MAX`. */
export function systemTransfer(from: PublicKey, to: PublicKey, lamports: bigint): Instruction {
  if (lamports <= 0n || lamports > U64_MAX) {
    throw new TransactionError('invalid_transfer', `systemTransfer: lamports out of range (got ${lamports})`, {
      detail: `lamports=${lamports}`,
    });
  }
  const data = new Uint8Array(DATA_LENGTH);
  const view = new DataView(data.buffer);
  view.setUint32(0, TRANSFER, true);
  view.setBigUint64(4, lamports, true);
  return {
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

/** The transfer `ix` encodes, or `null` when it is not exactly a SystemProgram transfer. */
export function parseSystemTransfer(ix: Instruction): SystemTransfer | null {
  if (!ix.programId.equals(SYSTEM_PROGRAM_ID) || ix.data.length !== DATA_LENGTH || ix.keys.length !== 2) return null;
  const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
  if (view.getUint32(0, true) !== TRANSFER) return null;
  const [from, to] = ix.keys as [Instruction['keys'][number], Instruction['keys'][number]];
  if (!from.isSigner || !from.isWritable || !to.isWritable) return null;
  return { from: from.pubkey, to: to.pubkey, lamports: view.getBigUint64(4, true) };
}
