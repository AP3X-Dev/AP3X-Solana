/**
 * `JitoBundleBuilder` — compose a payload of up to 5 signed transactions into
 * a structured Jito bundle, plus a helper for building SystemProgram transfer
 * instructions that tip a Jito tip account.
 *
 * This module is intentionally thin: it frames the bundle shape and enforces
 * the Jito protocol's 5-transaction-per-bundle ceiling. Actual submission
 * (block-engine HTTP, leader-slot coordination, tip-account rotation) is
 * deferred to PRP-03 (signal-layer execution) — this module only produces the
 * structured payload a submitter would consume.
 *
 * ---------------------------------------------------------------------------
 * SystemProgram.Transfer instruction encoding (Jito tip helper):
 * ---------------------------------------------------------------------------
 *
 *   data = [instruction_discriminator: u32 LE = 2 (Transfer)]
 *          [lamports: u64 LE]
 *
 * Total: 12 bytes. The discriminator `2` is the Transfer variant inside
 * Solana's SystemInstruction enum.
 *
 * The tip instruction is a plain SystemProgram transfer — callers compose it
 * alongside their other instructions via {@link assemble}. The `from` account
 * is signer+writable; the tip account is non-signer+writable.
 */

import { Ap3xError, PublicKey } from '@ap3x/solana-core';

import { TransactionError } from './transaction-assembler';
import type { Instruction } from './transaction-assembler';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/**
 * Jito protocol limit — at most 5 signed transactions per bundle. The block
 * engine rejects bundles that exceed this ceiling, so we surface the failure
 * at compose time rather than at submission.
 */
export const JITO_MAX_TXS_PER_BUNDLE = 5;

/**
 * SystemProgram pubkey — 32 zero bytes, base58 encoded as
 * `11111111111111111111111111111111`. Used as the `programId` for the tip
 * instruction.
 */
export const SYSTEM_PROGRAM_ID: PublicKey = PublicKey.fromBytes(
  new Uint8Array(32),
);

/** SystemInstruction::Transfer discriminator inside the SystemProgram enum. */
const SYSTEM_TRANSFER_DISCRIMINATOR = 2;

/** Byte length of the encoded SystemProgram transfer instruction data. */
const TRANSFER_DATA_LENGTH = 12;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured payload representing a Jito bundle — a list of already-signed,
 * wire-ready transactions. Submission is deferred to PRP-03; this type is the
 * hand-off point between the substrate and the venue-specific submitter.
 */
export interface Bundle {
  transactions: Uint8Array[];
}

// ---------------------------------------------------------------------------
// JitoBundleBuilder
// ---------------------------------------------------------------------------

/**
 * Composes signed transactions into {@link Bundle} payloads and helps build
 * the SystemProgram tip instruction that accompanies them.
 *
 * Stateless: the builder carries no configuration and multiple bundles can be
 * composed from a single instance (or fresh instances — it costs nothing).
 * Present as a class anyway so that future concerns (tip-account rotation,
 * per-bundle metadata, observability hooks) have a natural home.
 */
export class JitoBundleBuilder {
  /**
   * Compose up to {@link JITO_MAX_TXS_PER_BUNDLE} signed transactions into a
   * bundle payload. The returned bundle holds a fresh array — mutating the
   * caller's input after the call does not leak through, and mutating the
   * returned `transactions` array does not affect the caller's.
   *
   * @throws {@link TransactionError} (`tx.bundle_empty`) if `txs` is empty.
   * @throws {@link TransactionError} (`tx.bundle_too_large`) if `txs.length >
   *         5`.
   */
  compose(txs: Uint8Array[]): Bundle {
    if (txs.length === 0) {
      throw new TransactionError(
        'bundle_empty',
        'JitoBundleBuilder: bundle must contain at least one transaction',
      );
    }
    if (txs.length > JITO_MAX_TXS_PER_BUNDLE) {
      throw new TransactionError(
        'bundle_too_large',
        `JitoBundleBuilder: bundle exceeds Jito limit of ${JITO_MAX_TXS_PER_BUNDLE} transactions (got ${txs.length})`,
        { detail: `txs.length=${txs.length}` },
      );
    }
    // Shallow clone the array — the Uint8Array entries themselves remain
    // caller-owned (cloning them would double bundle memory for no gain).
    return { transactions: [...txs] };
  }

  /**
   * Build a SystemProgram Transfer instruction that tips a Jito tip account.
   * The caller is expected to include this instruction alongside their other
   * instructions in {@link assemble}.
   *
   * `from` becomes a signer + writable account; `tipAccount` becomes a
   * non-signer + writable account. The data buffer is 12 bytes:
   * `[discriminator u32 LE = 2][lamports u64 LE]`.
   *
   * @throws {@link TransactionError} (`tx.invalid_tip`) if `lamports <= 0`.
   *         A zero or negative tip is rejected defensively — the whole point
   *         of the tip is to pay the validator for bundle inclusion, so an
   *         empty tip is almost certainly a caller bug.
   */
  tipInstruction(
    from: PublicKey,
    tipAccount: PublicKey,
    lamports: bigint,
  ): Instruction {
    if (lamports <= 0n) {
      throw new TransactionError(
        'invalid_tip',
        `JitoBundleBuilder: tip lamports must be positive (got ${lamports})`,
        { detail: `lamports=${lamports}` },
      );
    }

    // SystemProgram Transfer instruction data — little-endian throughout.
    //   [0..4)  u32 discriminator = 2 (Transfer)
    //   [4..12) u64 lamports
    const data = new Uint8Array(TRANSFER_DATA_LENGTH);
    const view = new DataView(data.buffer);
    view.setUint32(0, SYSTEM_TRANSFER_DISCRIMINATOR, true);
    view.setBigUint64(4, lamports, true);

    return {
      programId: SYSTEM_PROGRAM_ID,
      keys: [
        { pubkey: from, isSigner: true, isWritable: true },
        { pubkey: tipAccount, isSigner: false, isWritable: true },
      ],
      data,
    };
  }
}

// Re-export the shared error base so callers can narrow via `instanceof` without
// reaching into `@ap3x/solana-core` directly.
export { Ap3xError };
