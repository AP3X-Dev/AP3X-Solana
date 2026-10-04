/**
 * AddressLookupTable program: create a table and extend it with addresses.
 *
 *   create: data = [u32 LE 0][recentSlot: u64 LE][bump: u8]          (13 bytes)
 *           keys = [table: writable, authority, payer: signer + writable, system program]
 *   extend: data = [u32 LE 2][count: u64 LE][count × 32-byte address]
 *           keys = [table: writable, authority: signer, payer: signer + writable, system program]
 *
 * The table address is the PDA of [authority, recentSlot as u64 LE]; the slot
 * must be recent (within ~150 slots) when the create lands. The authority
 * need not sign the create (relaxed on mainnet), but must sign every extend.
 * A new table's addresses are usable from the slot after they were added.
 */

import { PublicKey } from '@ap3x/solana-core';

import { findProgramAddress } from './find-program-address';
import { SYSTEM_PROGRAM_ID } from './system-transfer';
import { TransactionError } from './transaction-assembler';
import type { Instruction } from './transaction-assembler';

export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = PublicKey.fromBase58('AddressLookupTab1e1111111111111111111111111');

const CREATE = 0;
const EXTEND = 2;
/** A table holds at most 256 addresses. */
export const MAX_LOOKUP_TABLE_ADDRESSES = 256;
/** Addresses per extend that keep a legacy transaction under 1232 bytes. */
export const MAX_EXTEND_ADDRESSES = 30;

const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

export function createLookupTable(authority: PublicKey, payer: PublicKey, recentSlot: bigint): { table: PublicKey; instruction: Instruction } {
  if (recentSlot < 0n || recentSlot >= 1n << 64n) throw new TransactionError('invalid_lookup_table', `recentSlot out of range (got ${recentSlot})`);
  const { address: table, bump } = findProgramAddress([authority.toBuffer(), u64(recentSlot)], ADDRESS_LOOKUP_TABLE_PROGRAM_ID);
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, CREATE, true);
  view.setBigUint64(4, recentSlot, true);
  data[12] = bump;
  return {
    table,
    instruction: {
      programId: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
      keys: [
        { pubkey: table, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: false, isWritable: false },
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    },
  };
}

export function extendLookupTable(table: PublicKey, authority: PublicKey, payer: PublicKey, addresses: PublicKey[]): Instruction {
  if (addresses.length < 1 || addresses.length > MAX_EXTEND_ADDRESSES) {
    throw new TransactionError('invalid_lookup_table', `extend takes 1..${MAX_EXTEND_ADDRESSES} addresses (got ${addresses.length})`);
  }
  const data = new Uint8Array(12 + 32 * addresses.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, EXTEND, true);
  view.setBigUint64(4, BigInt(addresses.length), true);
  addresses.forEach((a, i) => data.set(a.toBuffer(), 12 + 32 * i));
  return {
    programId: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    keys: [
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  };
}
