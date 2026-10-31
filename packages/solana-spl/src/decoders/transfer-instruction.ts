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
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../program-ids.js';

/**
 * SPL Token v1 program ID (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
 *
 * Alias of {@link TOKEN_PROGRAM_ID} from program-ids.ts. Exported here so
 * decoder consumers can reference it directly without importing
 * `@ap3x/solana-spl/program-ids`.
 */
export const SPL_TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID;

/**
 * SPL Token-2022 program ID (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
 *
 * Alias of {@link TOKEN_2022_PROGRAM_ID} from program-ids.ts.
 */
export const SPL_TOKEN_2022_PROGRAM_ID = TOKEN_2022_PROGRAM_ID;

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

/** Instruction semantics only: neither authority nor multisig accounts establish beneficial ownership. */
export interface DecodedTransferDetails extends DecodedTransfer {
  variant: 'transfer' | 'transferChecked' | 'transferCheckedWithFee';
  mint: PublicKey | null;
  decimals: number | null;
  authority: PublicKey;
  multisigSigners: PublicKey[];
  /** Encoded fee expectation for TransferCheckedWithFee; null means the instruction does not specify one.
   * This is not an applied fee or a receipt of execution. Ordinary Token-2022 transfers may also withhold fees. */
  expectedFee: bigint | null;
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
  // Preserve the original API's variants and output shape for existing consumers.
  if (ix.data[0] !== VARIANT_TRANSFER && ix.data[0] !== VARIANT_TRANSFER_CHECKED) return null;
  const details = decodeTransferInstructionDetails(ix);
  return details ? { source: details.source, dest: details.dest, amount: details.amount } : null;
}

/**
 * Decode ordinary transfers and Token-2022 TransferCheckedWithFee (extension 26, subtag 1).
 * Preserves raw u64s and the encoded mint/decimals/authority. Does not resolve owners,
 * calculate implicit withholding, validate signatures or establish transaction success.
 * Wire references: spl-token-2022-interface 4.0.0 instruction.rs and transfer_fee/instruction.rs.
 */
export function decodeTransferInstructionDetails(ix: InstructionShape): DecodedTransferDetails | null {
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
    return { source: ix.accounts[0]!, dest: ix.accounts[1]!, amount,
      variant: 'transfer', mint: null, decimals: null, authority: ix.accounts[2]!,
      multisigSigners: ix.accounts.slice(3), expectedFee: null };
  }

  if (variant === VARIANT_TRANSFER_CHECKED) {
    // Layout: [variant: u8 (1)][amount: u64 LE (8)][decimals: u8 (1)] = 10 bytes minimum.
    // Accounts: [source, mint, dest, owner/multisig]
    if (ix.data.length < 10 || ix.accounts.length < 4) return null;
    const amount = readU64LE(ix.data, 1);
    return { source: ix.accounts[0]!, dest: ix.accounts[2]!, amount,
      variant: 'transferChecked', mint: ix.accounts[1]!, decimals: ix.data[9]!,
      authority: ix.accounts[3]!, multisigSigners: ix.accounts.slice(4), expectedFee: null };
  }

  if (ix.programId.equals(SPL_TOKEN_2022_PROGRAM_ID) && variant === 26 && ix.data[1] === 1) {
    // [extension u8][subtag u8][amount u64 LE][decimals u8][expected fee u64 LE].
    // Accounts: [source, mint, destination, authority, optional multisig signers...].
    if (ix.data.length < 19 || ix.accounts.length < 4) return null;
    return { source: ix.accounts[0]!, mint: ix.accounts[1]!, dest: ix.accounts[2]!,
      amount: readU64LE(ix.data, 2), decimals: ix.data[10]!, authority: ix.accounts[3]!,
      multisigSigners: ix.accounts.slice(4), expectedFee: readU64LE(ix.data, 11),
      variant: 'transferCheckedWithFee' };
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
