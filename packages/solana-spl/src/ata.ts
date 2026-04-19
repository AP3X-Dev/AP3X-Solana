/**
 * Associated Token Account (ATA) derivation + instruction builder.
 *
 * An ATA is the canonical PDA for a `(owner, tokenProgram, mint)` triple,
 * derived under the Associated Token Account program ID
 * (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`). Convention:
 *
 *     seeds      = [owner, tokenProgram, mint]  (each 32 bytes, raw pubkey)
 *     programId  = ATA_PROGRAM
 *     ata        = findProgramAddress(seeds, programId).address
 *
 * The optional `tokenProgram` parameter lets callers derive ATAs for
 * Token-2022 mints by passing `TOKEN_2022_PROGRAM_ID`. The ATA program
 * treats the tokenProgram field as an opaque seed — it doesn't validate
 * that it's a real token program — so the derivation works for any
 * arbitrary 32-byte pubkey. Callers are responsible for picking the right
 * one.
 *
 * ## Off-curve owners
 *
 * An ATA can belong to a PDA (e.g. a program-owned escrow). PDAs are
 * off-curve by construction, so the normal ed25519 "is this a valid
 * pubkey?" check would reject them. We expose `allowOwnerOffCurve` to let
 * PDA-owned ATAs through while rejecting accidental off-curve owners for
 * end-user wallets (which must be real keypairs).
 *
 * The `isOnCurve` check mirrors {@link solana-tx/findProgramAddress}: we
 * try to decode the pubkey as an ed25519 point via `@noble/ed25519`'s
 * `Point.fromHex` and treat a success as "on-curve". A throw means
 * "off-curve" (which is what we want to allow only when
 * `allowOwnerOffCurve = true`).
 *
 * ## Instruction builder
 *
 * {@link createAssociatedTokenAccountIx} builds a CreateIdempotent
 * instruction (discriminator byte `1`). CreateIdempotent is strictly
 * preferred over Create (disc `0`): it's a no-op when the ATA already
 * exists, so multi-transaction flows won't fail on retry. The alternative
 * (plain Create, disc `0`) would throw an error on a pre-existing ATA,
 * which is almost never the behaviour a client wants.
 *
 * Zero forbidden deps: only `@ap3x/solana-core`, `@ap3x/solana-tx`
 * (PDA helper only), and `@noble/ed25519` (off-curve check, project-
 * whitelisted).
 */

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './program-ids';

// @noble/ed25519 v2.x requires the host to install a sha512 implementation
// because it needs it for point decompression / scalar-hashing. Install both
// sync and async forms to match the convention used elsewhere in the
// substrate (see `solana-tx/find-program-address` and `solana-vault`).
// Multiple installs are idempotent — last write wins.
ed.etc.sha512Async = (...msgs: Uint8Array[]) =>
  Promise.resolve(sha512(ed.etc.concatBytes(...msgs)));
ed.etc.sha512Sync = (...msgs: Uint8Array[]) =>
  sha512(ed.etc.concatBytes(...msgs));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An `AccountMeta` mirrors the transaction-assembler shape from
 * `@ap3x/solana-tx` — we can't import that type under the
 * `no-restricted-imports` rule so we redeclare it locally. The shape is
 * structurally compatible: any consumer that accepts `AccountMeta` from tx
 * will accept ours unchanged.
 */
export interface AccountMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

/** An instruction ready to feed into a transaction assembler. */
export interface Instruction {
  programId: PublicKey;
  keys: AccountMeta[];
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// On-curve check
// ---------------------------------------------------------------------------

/**
 * Return `true` iff the 32-byte pubkey decodes to a valid ed25519 curve
 * point. PDAs are off-curve and will return `false`.
 */
function isOnCurve(pk: PublicKey): boolean {
  try {
    ed.Point.fromHex(pk.toBuffer());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ATA derivation
// ---------------------------------------------------------------------------

/**
 * Derive the canonical Associated Token Account address for a
 * `(mint, owner)` pair.
 *
 * @param mint              The token mint.
 * @param owner             The owner (end-user wallet or PDA).
 * @param allowOwnerOffCurve When `false` (default) we reject off-curve
 *                          owners — a common mistake is passing a PDA as
 *                          owner, which would silently succeed but produce
 *                          an ATA that can never be signed for. Set to
 *                          `true` when the owner really is a PDA.
 * @param tokenProgramId    Which SPL Token flavour the ATA is for. Defaults
 *                          to Token v1; pass `TOKEN_2022_PROGRAM_ID` for
 *                          Token-2022 mints.
 * @throws Error if `!allowOwnerOffCurve && !isOnCurve(owner)`.
 */
export function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  if (!allowOwnerOffCurve && !isOnCurve(owner)) {
    throw new Error(
      `getAssociatedTokenAddress: owner ${owner.toBase58()} is off-curve — pass allowOwnerOffCurve=true if the owner is intentionally a PDA`,
    );
  }
  const { address } = findProgramAddress(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

// ---------------------------------------------------------------------------
// Instruction builder — CreateIdempotent
// ---------------------------------------------------------------------------

/** ATA program instruction discriminators we know about. */
const ATA_INSTRUCTION = Object.freeze({
  Create: 0,
  CreateIdempotent: 1,
} as const);

/**
 * Build a CreateIdempotent instruction for the ATA of `(mint, owner)`. If
 * the ATA already exists the runtime silently succeeds, so this is safe to
 * include in retry flows.
 *
 * The instruction's account order matches the ATA program's ABI:
 *
 *   0. payer        — funds the rent-exempt reserve (signer, writable)
 *   1. ata          — the ATA address to create (writable)
 *   2. owner        — the resulting token account's owner
 *   3. mint         — the token mint
 *   4. systemProgram
 *   5. tokenProgram — Token v1 or Token-2022
 *
 * Off-curve owners are ALLOWED here because it's legal to create an ATA
 * for a PDA (a program-owned escrow, for instance). We derive with
 * `allowOwnerOffCurve = true` to avoid a needless rejection.
 */
export function createAssociatedTokenAccountIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): Instruction {
  const ata = getAssociatedTokenAddress(mint, owner, true, tokenProgramId);
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([ATA_INSTRUCTION.CreateIdempotent]),
  };
}

/**
 * Build a plain Create instruction. Provided for completeness — most
 * callers should prefer {@link createAssociatedTokenAccountIx} because
 * it's retry-safe.
 *
 * The wire shape is identical except for the single-byte discriminator.
 */
export function createAssociatedTokenAccountNonIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): Instruction {
  const ix = createAssociatedTokenAccountIx(payer, owner, mint, tokenProgramId);
  return { ...ix, data: new Uint8Array([ATA_INSTRUCTION.Create]) };
}
