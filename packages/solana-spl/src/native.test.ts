import { describe, expect, it } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';

import { closeAccountIx, NATIVE_MINT, syncNativeIx } from './native';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './program-ids';

const A = PublicKey.fromBytes(new Uint8Array(32).fill(1));
const B = PublicKey.fromBytes(new Uint8Array(32).fill(2));
const C = PublicKey.fromBytes(new Uint8Array(32).fill(3));

describe('wrapped SOL helpers', () => {
  it('exposes the WSOL mint', () => {
    expect(NATIVE_MINT.toBase58()).toBe('So11111111111111111111111111111111111111112');
  });

  it('builds SyncNative', () => {
    const ix = syncNativeIx(A);
    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(Array.from(ix.data)).toEqual([17]);
    expect(ix.keys).toEqual([{ pubkey: A, isSigner: false, isWritable: true }]);
  });

  it('builds CloseAccount with the owner as the only signer', () => {
    const ix = closeAccountIx(A, B, C, TOKEN_2022_PROGRAM_ID);
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(Array.from(ix.data)).toEqual([9]);
    expect(ix.keys).toEqual([
      { pubkey: A, isSigner: false, isWritable: true },
      { pubkey: B, isSigner: false, isWritable: true },
      { pubkey: C, isSigner: true, isWritable: false },
    ]);
  });
});
