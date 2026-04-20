/**
 * SPL Token transfer instruction decoder.
 *
 * Handles both the classic `Transfer` (variant 3) and `TransferChecked`
 * (variant 12) instruction layouts for SPL Token v1 and Token-2022 programs.
 * Returns a `DecodedTransfer` on success, or `null` if the instruction is not
 * a recognised transfer variant for one of the two SPL token programs.
 *
 * Zero ecosystem deps — only `@ap3x/solana-core` for the `PublicKey` type.
 */

import { PublicKey } from '@ap3x/solana-core';

/**
 * SPL Token v1 program ID (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
 *
 * Aliased here so decoder consumers can reference it directly without
 * importing `@ap3x/solana-spl/program-ids`.
 */
export const SPL_TOKEN_PROGRAM_ID = /* @__PURE__ */ PublicKey.fromBase58(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/**
 * SPL Token-2022 program ID (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
 */
export const SPL_TOKEN_2022_PROGRAM_ID = /* @__PURE__ */ PublicKey.fromBase58(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

/** Minimal instruction shape consumed by the decoder. */
export interface InstructionShape {
  programId: PublicKey;
  accounts: PublicKey[];
  data: Uint8Array;
}

/** Decoded transfer fields common to both Transfer and TransferChecked. */
export interface DecodedTransfer {
  source: PublicKey;
  dest: PublicKey;
  /** Token amount as a raw u64 (no decimal scaling). */
  amount: bigint;
}

// SPL Token instruction variant discriminants.
const VARIANT_TRANSFER = 3;
const VARIANT_TRANSFER_CHECKED = 12;

/**
 * Decode an SPL Token `Transfer` or `TransferChecked` instruction.
 *
 * @returns Decoded transfer fields, or `null` when the instruction does not
 *   match a recognised SPL transfer variant.
 */
export function decodeTransferInstruction(ix: InstructionShape): DecodedTransfer | null {
  if (
    !ix.programId.equals(SPL_TOKEN_PROGRAM_ID) &&
    !ix.programId.equals(SPL_TOKEN_2022_PROGRAM_ID)
  ) {
    return null;
  }
  if (ix.data.length === 0) return null;
  const variant = ix.data[0];

  if (variant === VARIANT_TRANSFER) {
    // Layout: [variant: u8 (1)][amount: u64 LE (8)] = 9 bytes minimum.
    // Accounts: [source, dest, owner/multisig]
    if (ix.data.length < 9 || ix.accounts.length < 3) return null;
    const amount = readU64LE(ix.data, 1);
    return { source: ix.accounts[0]!, dest: ix.accounts[1]!, amount };
  }

  if (variant === VARIANT_TRANSFER_CHECKED) {
    // Layout: [variant: u8 (1)][amount: u64 LE (8)][decimals: u8 (1)] = 10 bytes minimum.
    // Accounts: [source, mint, dest, owner/multisig]
    if (ix.data.length < 10 || ix.accounts.length < 4) return null;
    const amount = readU64LE(ix.data, 1);
    return { source: ix.accounts[0]!, dest: ix.accounts[2]!, amount };
  }

  return null;
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(buf[offset + i]!) << BigInt(i * 8);
  }
  return result;
}
