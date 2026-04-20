import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { decodeTransferInstruction, SPL_TOKEN_PROGRAM_ID } from './transfer-instruction.js';

describe('decodeTransferInstruction', () => {
  it('decodes a Transfer (variant 3) with amount', () => {
    // SPL Token instruction layout: [variant: u8][amount: u64 LE]
    // Transfer = variant 3, amount = 1_000_000 lamports
    const data = new Uint8Array([3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]);
    const source = PublicKey.fromBase58('11111111111111111111111111111112');
    const dest = PublicKey.fromBase58('11111111111111111111111111111113');
    const owner = PublicKey.fromBase58('11111111111111111111111111111114');
    const ix = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [source, dest, owner],
      data,
    };
    const result = decodeTransferInstruction(ix);
    expect(result).toEqual({ source, dest, amount: 1_000_000n });
  });

  it('returns null for non-SPL Token program', () => {
    const data = new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0]);
    const ix = {
      programId: PublicKey.fromBase58('11111111111111111111111111111111'),
      accounts: [],
      data,
    };
    expect(decodeTransferInstruction(ix)).toBeNull();
  });

  it('returns null for non-Transfer variants', () => {
    const data = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0]); // variant 0 (InitializeMint)
    const ix = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [PublicKey.fromBase58('11111111111111111111111111111112')],
      data,
    };
    expect(decodeTransferInstruction(ix)).toBeNull();
  });

  it('decodes TransferChecked (variant 12) with amount + decimals', () => {
    // TransferChecked = variant 12, amount = 5, decimals = 9
    const data = new Uint8Array([12, 5, 0, 0, 0, 0, 0, 0, 0, 9]);
    const ix = {
      programId: SPL_TOKEN_PROGRAM_ID,
      accounts: [
        PublicKey.fromBase58('11111111111111111111111111111112'),
        PublicKey.fromBase58('11111111111111111111111111111113'),
        PublicKey.fromBase58('11111111111111111111111111111114'),
        PublicKey.fromBase58('11111111111111111111111111111115'),
      ],
      data,
    };
    const result = decodeTransferInstruction(ix);
    expect(result).toEqual({
      source: PublicKey.fromBase58('11111111111111111111111111111112'),
      dest: PublicKey.fromBase58('11111111111111111111111111111114'),
      amount: 5n,
    });
  });
});
