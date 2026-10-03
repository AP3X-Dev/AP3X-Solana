import { describe, expect, it } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';

import { parseSystemTransfer, systemTransfer, SYSTEM_PROGRAM_ID } from './system-transfer';
import { TransactionError } from './transaction-assembler';
import type { Instruction } from './transaction-assembler';

const A = PublicKey.fromBase58('DLC4m7MrXPa8dtSGceJQ3ASe7H34eiuSJE9pdE8WvjGS');
const B = PublicKey.fromBase58('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const U64_MAX = (1n << 64n) - 1n;

describe('systemTransfer', () => {
  it('encodes the SystemProgram transfer layout', () => {
    const ix = systemTransfer(A, B, 10_000_000n);
    expect(ix.programId.equals(SYSTEM_PROGRAM_ID)).toBe(true);
    expect(Array.from(ix.data)).toEqual([2, 0, 0, 0, 0x80, 0x96, 0x98, 0, 0, 0, 0, 0]);
    expect(ix.keys).toEqual([
      { pubkey: A, isSigner: true, isWritable: true },
      { pubkey: B, isSigner: false, isWritable: true },
    ]);
  });

  it('round-trips through the parser, up to u64::MAX', () => {
    for (const lamports of [1n, 990_000_000n, U64_MAX]) {
      const t = parseSystemTransfer(systemTransfer(A, B, lamports))!;
      expect(t.from.equals(A) && t.to.equals(B)).toBe(true);
      expect(t.lamports).toBe(lamports);
    }
  });

  it('rejects zero, negative and over-u64 amounts', () => {
    for (const lamports of [0n, -1n, U64_MAX + 1n]) {
      expect(() => systemTransfer(A, B, lamports)).toThrow(TransactionError);
    }
  });
});

describe('parseSystemTransfer', () => {
  const good = systemTransfer(A, B, 5n);
  const variant = (patch: Partial<Instruction>): Instruction => ({ ...good, ...patch });

  it('returns null for anything that is not exactly a transfer', () => {
    const data = (mutate: (d: Uint8Array) => void) => {
      const d = new Uint8Array(good.data);
      mutate(d);
      return d;
    };
    expect(parseSystemTransfer(variant({ programId: B }))).toBeNull();
    expect(parseSystemTransfer(variant({ data: data((d) => (d[0] = 3)) }))).toBeNull();
    expect(parseSystemTransfer(variant({ data: good.data.subarray(0, 11) }))).toBeNull();
    expect(parseSystemTransfer(variant({ keys: [good.keys[0]!] }))).toBeNull();
    expect(parseSystemTransfer(variant({ keys: [...good.keys, good.keys[1]!] }))).toBeNull();
    expect(parseSystemTransfer(variant({ keys: [{ ...good.keys[0]!, isSigner: false }, good.keys[1]!] }))).toBeNull();
    expect(parseSystemTransfer(variant({ keys: [good.keys[0]!, { ...good.keys[1]!, isWritable: false }] }))).toBeNull();
  });

  it('reads data that sits at an offset inside a larger buffer', () => {
    const backing = new Uint8Array(20);
    backing.set(good.data, 5);
    expect(parseSystemTransfer(variant({ data: backing.subarray(5, 17) }))!.lamports).toBe(5n);
  });
});
