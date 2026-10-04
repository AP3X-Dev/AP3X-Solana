import { describe, expect, it } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';

import { findProgramAddress } from './find-program-address';
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ID, createLookupTable, extendLookupTable, MAX_EXTEND_ADDRESSES } from './lookup-table-instructions';
import { SYSTEM_PROGRAM_ID } from './system-transfer';

const AUTH = PublicKey.fromBase58('DLC4m7MrXPa8dtSGceJQ3ASe7H34eiuSJE9pdE8WvjGS');
const PAYER = PublicKey.fromBase58('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

describe('lookup table instructions', () => {
  it('create: table is the PDA of [authority, slot LE], data is [0 u32][slot u64][bump]', () => {
    const slot = 453_207_421n;
    const { table, instruction } = createLookupTable(AUTH, PAYER, slot);
    const seed = new Uint8Array(8);
    new DataView(seed.buffer).setBigUint64(0, slot, true);
    const pda = findProgramAddress([AUTH.toBuffer(), seed], ADDRESS_LOOKUP_TABLE_PROGRAM_ID);
    expect(table.toBase58()).toBe(pda.address.toBase58());
    expect([...instruction.data]).toEqual([0, 0, 0, 0, ...seed, pda.bump]);
    expect(instruction.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [table.toBase58(), false, true],
      [AUTH.toBase58(), false, false],
      [PAYER.toBase58(), true, true],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
    ]);
  });

  it('extend: data is [2 u32][count u64][addresses], authority signs', () => {
    const table = createLookupTable(AUTH, PAYER, 1n).table;
    const ix = extendLookupTable(table, AUTH, PAYER, [PAYER, AUTH]);
    expect([...ix.data.slice(0, 12)]).toEqual([2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(ix.data.slice(12, 44)).toEqual(PAYER.toBuffer());
    expect(ix.data.slice(44)).toEqual(AUTH.toBuffer());
    expect(ix.keys[1]).toMatchObject({ isSigner: true, isWritable: false });
    expect(() => extendLookupTable(table, AUTH, PAYER, [])).toThrow(/1\.\.30/);
    expect(() => extendLookupTable(table, AUTH, PAYER, Array(MAX_EXTEND_ADDRESSES + 1).fill(PAYER))).toThrow(/1\.\.30/);
  });
});
