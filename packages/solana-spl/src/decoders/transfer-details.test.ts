import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import {
  decodeTransferInstruction, decodeTransferInstructionDetails,
  SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID,
} from './transfer-instruction.js';

const keys = Array.from({ length: 6 }, (_, n) => PublicKey.fromBytes(new Uint8Array(32).fill(n + 1)));
const [source, mint, dest, authority, signer1, signer2] = keys;
function instruction(programId: PublicKey, variant: number, amount: bigint, decimals = 9, fee = 0n) {
  const checked = variant !== 3;
  const data = new Uint8Array(variant === 26 ? 19 : checked ? 10 : 9);
  data[0] = variant;
  const view = new DataView(data.buffer);
  if (variant === 26) {
    data[1] = 1;
    view.setBigUint64(2, amount, true);
    data[10] = decimals;
    view.setBigUint64(11, fee, true);
  } else {
    view.setBigUint64(1, amount, true);
    if (checked) data[9] = decimals;
  }
  return { programId, accounts: checked ? [source!, mint!, dest!, authority!] : [source!, dest!, authority!], data };
}

describe('transfer instruction details', () => {
  for (const program of [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID]) {
    for (const variant of [3, 12]) it(`preserves ${variant} fields for ${program.toBase58()}`, () => {
      const ix = instruction(program, variant, 18446744073709551615n, 255);
      expect(decodeTransferInstructionDetails(ix)).toEqual({
        source, dest, amount: 18446744073709551615n,
        variant: variant === 3 ? 'transfer' : 'transferChecked',
        mint: variant === 3 ? null : mint, decimals: variant === 3 ? null : 255,
        authority, multisigSigners: [], expectedFee: null,
      });
      expect(decodeTransferInstruction(ix)).toEqual({ source, dest, amount: 18446744073709551615n });
    });
  }

  it('decodes the Token-2022 explicit-fee wire vector without treating authority as owner', () => {
    // Independently specified little-endian wire vector: extension 26, subtag 1, amount 1000, decimals 6, fee 7.
    const ix = {
      programId: SPL_TOKEN_2022_PROGRAM_ID,
      accounts: [source!, mint!, dest!, authority!, signer1!, signer2!],
      data: new Uint8Array([26, 1, 232, 3, 0, 0, 0, 0, 0, 0, 6, 7, 0, 0, 0, 0, 0, 0, 0]),
    };
    expect(decodeTransferInstructionDetails(ix)).toEqual({
      source, mint, dest, amount: 1000n, decimals: 6, authority,
      multisigSigners: [signer1, signer2], expectedFee: 7n, variant: 'transferCheckedWithFee',
    });
    // The older API remains restricted to the two originally documented variants.
    expect(decodeTransferInstruction(ix)).toBeNull();
  });

  it('retains explicit zero and maximum u64 fees as instruction expectations, not applied amounts', () => {
    for (const fee of [0n, 18446744073709551615n]) {
      const decoded = decodeTransferInstructionDetails(instruction(SPL_TOKEN_2022_PROGRAM_ID, 26, 0n, 0, fee));
      expect(decoded?.amount).toBe(0n);
      expect(decoded?.expectedFee).toBe(fee);
      expect(decoded?.decimals).toBe(0);
    }
  });

  it('does not infer a zero fee for ordinary Token-2022 instructions', () => {
    expect(decodeTransferInstructionDetails(instruction(SPL_TOKEN_2022_PROGRAM_ID, 12, 10n))?.expectedFee).toBeNull();
  });

  it('retains multisig account references for ordinary transfers', () => {
    const ix = instruction(SPL_TOKEN_PROGRAM_ID, 3, 1n);
    ix.accounts.push(signer1!, signer2!);
    expect(decodeTransferInstructionDetails(ix)?.multisigSigners).toEqual([signer1, signer2]);
  });

  it('refuses every truncated layout and missing required account', () => {
    for (const variant of [3, 12, 26]) {
      const ix = instruction(SPL_TOKEN_2022_PROGRAM_ID, variant, 9n);
      for (let length = 0; length < ix.data.length; length++)
        expect(decodeTransferInstructionDetails({ ...ix, data: ix.data.slice(0, length) })).toBeNull();
      for (let length = 0; length < ix.accounts.length; length++)
        expect(decodeTransferInstructionDetails({ ...ix, accounts: ix.accounts.slice(0, length) })).toBeNull();
    }
  });

  it('refuses unknown programs, ordinary non-transfer tags and other extension subtags', () => {
    const ix = instruction(SPL_TOKEN_2022_PROGRAM_ID, 26, 100n);
    expect(decodeTransferInstructionDetails({ ...ix, programId: source! })).toBeNull();
    expect(decodeTransferInstructionDetails({ ...ix, programId: SPL_TOKEN_PROGRAM_ID })).toBeNull();
    for (const tag of [0, 1, 2, 4, 6, 255])
      expect(decodeTransferInstructionDetails({ ...ix, data: Uint8Array.of(tag, ...ix.data.slice(1)) })).toBeNull();
    for (const tag of [0, 2, 3, 4, 5, 255]) {
      const data = ix.data.slice(); data[1] = tag;
      expect(decodeTransferInstructionDetails({ ...ix, data })).toBeNull();
    }
  });

  it('accepts trailing instruction data consistently with the program unpacker', () => {
    for (const variant of [3, 12, 26]) {
      const ix = instruction(SPL_TOKEN_2022_PROGRAM_ID, variant, 3n);
      expect(decodeTransferInstructionDetails({ ...ix, data: Uint8Array.of(...ix.data, 99) }))
        .toEqual(decodeTransferInstructionDetails(ix));
    }
  });
});
