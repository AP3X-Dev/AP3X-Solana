/**
 * `buildCreate` — pure instruction builder for pump.fun's bonding-curve
 * Create instruction.
 *
 * Mint a new pump.fun token and initialise its bonding-curve account. The
 * caller supplies the new mint pubkey (typically a freshly generated keypair),
 * the fee payer / creator, and the token metadata (name / symbol / uri).
 *
 * This file is pure: `buildCreate(params)` returns an `Instruction`
 * (`{ programId, keys, data }`). It does not sign, submit, or touch the
 * network. Callers hand the result to `@ap3x/solana-tx.assemble` with their
 * signer list and a fresh blockhash.
 *
 * -----------------------------------------------------------------------
 * BEST-EFFORT ASSUMPTIONS (unverified, flagged for mainnet confirmation):
 * -----------------------------------------------------------------------
 *
 *   1. **Account layout.** The 14-account positional layout below mirrors
 *      what third-party pump.fun SDKs publish. Without a captured mainnet
 *      Create transaction (blocked on a Helius API key) we cannot confirm
 *      positions, signer flags, or writable flags. Nightly diag + Task 5/6
 *      per-variant fixture tests surface drift once the key is available.
 *
 *   2. **Mint-authority PDA seed.** Derived from `[b"mint-authority"]` under
 *      the pump.fun bonding-curve program. Consistent with community SDKs,
 *      unconfirmed against the program itself. See {@link deriveMintAuthorityPda}.
 *
 *   3. **Create instruction discriminator.** Sourced from the shared
 *      `INSTRUCTION_DISCRIMINATORS.create` constant (Anchor
 *      `sha256("global:create")[..8]`). Regenerated from the published IDL
 *      if pump.fun ships one.
 *
 * The task description for PRP-02.5 Task 13 is explicit that this task
 * ships the starting shape, not the verified layout. When the live-sample
 * checkpoint lands, update this file and the roundtrip test together.
 *
 * -----------------------------------------------------------------------
 * Account order (index → role):
 * -----------------------------------------------------------------------
 *
 *    0  payer              (signer, writable)  — funds rent + tx fees
 *    1  mint               (signer, writable)  — new token mint (fresh keypair)
 *    2  mint-authority PDA (readonly)          — derived signer for the mint
 *    3  bonding-curve PDA  (writable)          — new curve state account
 *    4  associated-bonding-curve (writable)    — curve's token inventory ATA
 *    5  global PDA         (readonly)          — program-wide config
 *    6  metaplex token-metadata program
 *    7  metadata PDA       (writable)          — metaplex metadata account
 *    8  system program
 *    9  token program
 *   10  associated-token program
 *   11  sysvar rent
 *   12  event-authority PDA (readonly)         — CPI self-log authority
 *   13  bonding-curve program (self)           — required by Anchor event CPI
 *
 * The on-chain `creator` field recorded in the bonding-curve account is
 * populated from the signer at index 0 in practice. `CreateParams.creator`
 * and `CreateParams.payer` are kept as separate fields so a future relayer
 * pattern can distinguish the two; today they should be the same pubkey.
 */

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import type { Instruction, AccountMeta } from '@ap3x/solana-tx';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from '@ap3x/solana-spl';
import { METADATA_PROGRAM_ID, getMetadataPda } from '@ap3x/solana-metaplex';
import {
  deriveBondingCurvePda,
  deriveAssociatedBondingCurvePda,
  deriveGlobalPda,
  deriveEventAuthorityPda,
} from './account-derivation.js';
import {
  concat,
  discHex,
  encodeString,
  INSTRUCTION_DISCRIMINATORS,
} from './borsh.js';
import type { CreateParams } from './params.js';

const enc = new TextEncoder();

/**
 * Sysvar rent account (`SysvarRent111111111111111111111111111111111`).
 *
 * Required at a fixed position by pump.fun's Create instruction. Materialised
 * here rather than imported because `@ap3x/solana-core` does not ship sysvar
 * identifiers and hoisting this single value into a shared module is more
 * churn than it's worth for one caller.
 */
const SYSVAR_RENT = /* @__PURE__ */ PublicKey.fromBase58(
  'SysvarRent111111111111111111111111111111111',
);

/**
 * Derive the pump.fun mint-authority PDA.
 *
 *   seeds     = [b"mint-authority"]
 *   programId = PUMPFUN_BONDING_CURVE_PROGRAM_ID
 *
 * The mint authority for every pump.fun bonding-curve token is a single
 * program-wide PDA — the program itself CPI-signs mint operations. See the
 * top-of-file assumption note: seed is unconfirmed against on-chain until
 * the Helius-key-gated diag can inspect a real Create tx.
 */
function deriveMintAuthorityPda(): { address: PublicKey; bump: number } {
  return findProgramAddress(
    [enc.encode('mint-authority')],
    PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  );
}

/**
 * Build the raw `Instruction` for pump.fun's bonding-curve Create.
 *
 * Pure — returns `{ programId, keys, data }`. Callers hand the result to
 * `@ap3x/solana-tx.assemble` along with a signer list that covers every
 * account where `isSigner = true` (the payer and the mint).
 *
 * Validates metadata lengths:
 *   - `name`   must be 1..64 chars (Metaplex limit)
 *   - `symbol` must be 1..16 chars (Metaplex limit)
 * URI is not length-capped here; the program enforces its own upper bound
 * and we prefer to surface the on-chain error rather than duplicate a
 * constant that might drift.
 *
 * Does NOT include an initial buy. Atomic create+snipe composition is done
 * by the caller (compose `buildCreate` + `buildBuy` in the same tx). The
 * formal launch-and-snipe orchestrator ships in PRP-03.5.
 *
 * @throws TypeError when `name` or `symbol` length is out of range.
 */
export function buildCreate(params: CreateParams): Instruction {
  if (params.name.length === 0 || params.name.length > 64) {
    throw new TypeError('CreateParams.name must be 1-64 chars');
  }
  if (params.symbol.length === 0 || params.symbol.length > 16) {
    throw new TypeError('CreateParams.symbol must be 1-16 chars');
  }

  const { address: bondingCurve } = deriveBondingCurvePda(params.mint);
  const { address: associatedBondingCurve } = deriveAssociatedBondingCurvePda(
    params.mint,
  );
  const { address: global } = deriveGlobalPda();
  const { address: eventAuthority } = deriveEventAuthorityPda();
  const { address: mintAuthority } = deriveMintAuthorityPda();
  const { address: metadata } = getMetadataPda(params.mint);

  const keys: AccountMeta[] = [
    { pubkey: params.payer, isSigner: true, isWritable: true }, //            0
    { pubkey: params.mint, isSigner: true, isWritable: true }, //             1
    { pubkey: mintAuthority, isSigner: false, isWritable: false }, //         2
    { pubkey: bondingCurve, isSigner: false, isWritable: true }, //           3
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // 4
    { pubkey: global, isSigner: false, isWritable: false }, //                5
    { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false }, //   6
    { pubkey: metadata, isSigner: false, isWritable: true }, //               7
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, //     8
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, //      9
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 10
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false }, //           11
    { pubkey: eventAuthority, isSigner: false, isWritable: false }, //        12
    { pubkey: PUMPFUN_BONDING_CURVE_PROGRAM_ID, isSigner: false, isWritable: false }, // 13
  ];

  const data = concat(
    discHex(INSTRUCTION_DISCRIMINATORS.create),
    encodeString(params.name),
    encodeString(params.symbol),
    encodeString(params.uri),
  );

  return {
    programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID,
    keys,
    data,
  };
}
