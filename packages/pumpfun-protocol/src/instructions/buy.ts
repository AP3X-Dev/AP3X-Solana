/**
 * `buildBuy` — pure instruction builder for pump.fun's bonding-curve
 * Buy instruction.
 *
 * Spend lamports (`solIn`) on the bonding curve in exchange for the pump.fun
 * token. The caller supplies the mint, signing wallet, lamport input, slippage
 * ceiling, and their ATA for the mint (the builder does not derive or ensure
 * the ATA — strategies typically do an idempotent ATA-create upstream).
 *
 * Pure: returns `{ programId, keys, data }`. No signing, no network. Hand the
 * result to `@ap3x/solana-tx.assemble` with a signer list that covers `user`.
 *
 * -----------------------------------------------------------------------
 * BEST-EFFORT ASSUMPTIONS (unverified, flagged for mainnet confirmation):
 * -----------------------------------------------------------------------
 *
 *   1. **Account layout.** The 12-account positional layout below mirrors
 *      what third-party pump.fun SDKs publish for the Buy instruction. We
 *      include: global, feeRecipient, mint, bondingCurve, associatedBondingCurve,
 *      user, userTokenAccount, systemProgram, tokenProgram, rent, eventAuthority,
 *      program. Without a captured mainnet Buy transaction (blocked on a
 *      Helius API key) positions and writable flags cannot be confirmed.
 *      Nightly diag + Task 5/6 per-variant fixture tests surface drift once
 *      the key is available.
 *
 *   2. **Fee-recipient PDA seed.** Derived from
 *      `[b"fee_recipient", PUMPFUN_BONDING_CURVE_PROGRAM_ID]` per the PDA
 *      vectors already codified in `@ap3x/solana-tx`'s regression fixture.
 *      Consistent with community SDKs but unverified against the program
 *      itself. See {@link deriveFeeRecipientPda}.
 *
 *   3. **Buy instruction discriminator.** Sourced from
 *      `INSTRUCTION_DISCRIMINATORS.buy` (Anchor
 *      `sha256("global:buy")[..8]`). Regenerate from the published IDL if
 *      pump.fun ships one.
 *
 * As with `buildCreate`, the task description for PRP-02.5 Task 14 is
 * explicit that this ships the starting shape, not the verified layout. When
 * the live-sample checkpoint lands, update this file and the roundtrip
 * fixture together.
 *
 * -----------------------------------------------------------------------
 * Account order (index → role):
 * -----------------------------------------------------------------------
 *
 *    0  global PDA               (readonly)          — program-wide config
 *    1  fee-recipient PDA        (writable)          — protocol-fee sink
 *    2  mint                     (readonly)          — the pump.fun token mint
 *    3  bonding-curve PDA        (writable)          — curve state
 *    4  associated-bonding-curve (writable)          — curve's token inventory ATA
 *    5  user token account       (writable)          — caller's ATA for `mint`
 *    6  user                     (signer, writable)  — buyer, pays SOL + fees
 *    7  system program
 *    8  token program
 *    9  sysvar rent
 *   10  event-authority PDA      (readonly)          — CPI self-log authority
 *   11  bonding-curve program (self)                  — required by Anchor event CPI
 *
 * Instruction data:
 *   [0..8]   discriminator  (hex `66063d1201daebea` → `INSTRUCTION_DISCRIMINATORS.buy`)
 *   [8..16]  solIn          u64 LE — lamports committed to the buy
 *   [16..24] maxSolCost     u64 LE — slippage ceiling in lamports
 */

import { PublicKey } from '@ap3x/solana-core';
import type { Instruction, AccountMeta } from '@ap3x/solana-tx';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import {
  TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from '@ap3x/solana-spl';
import {
  deriveBondingCurvePda,
  deriveAssociatedBondingCurvePda,
  deriveGlobalPda,
  deriveEventAuthorityPda,
  deriveFeeRecipientPda,
} from './account-derivation.js';
import {
  concat,
  discHex,
  encodeU64LE,
  INSTRUCTION_DISCRIMINATORS,
} from './borsh.js';
import type { BuyParams } from './params.js';

/**
 * Sysvar rent account (`SysvarRent111111111111111111111111111111111`).
 *
 * Required at a fixed position by pump.fun's Buy instruction. Materialised
 * inline rather than imported because `@ap3x/solana-core` does not ship
 * sysvar identifiers and hoisting this single value into a shared module is
 * more churn than it's worth for one caller.
 */
const SYSVAR_RENT = /* @__PURE__ */ PublicKey.fromBase58(
  'SysvarRent111111111111111111111111111111111',
);

/**
 * Build the raw `Instruction` for pump.fun's bonding-curve Buy.
 *
 * Pure — returns `{ programId, keys, data }`. Callers hand the result to
 * `@ap3x/solana-tx.assemble` along with a signer list that covers `user`.
 *
 * Validates amount semantics:
 *   - `solIn > 0n`                — zero-lamport buys are never useful.
 *   - `maxSolCost >= solIn`       — a ceiling below the notional would
 *                                    guarantee on-chain rejection.
 *
 * Does NOT ensure the ATA exists. Callers should precede this with an
 * idempotent `createAssociatedTokenAccountIdempotent` from `@ap3x/solana-spl`
 * when appropriate — the builder is strict about staying pure.
 *
 * @throws TypeError when `solIn <= 0n` or `maxSolCost < solIn`.
 */
export function buildBuy(params: BuyParams): Instruction {
  if (params.solIn <= 0n) {
    throw new TypeError('BuyParams.solIn must be > 0');
  }
  if (params.maxSolCost < params.solIn) {
    throw new TypeError('BuyParams.maxSolCost must be >= solIn');
  }

  const { address: bondingCurve } = deriveBondingCurvePda(params.mint);
  const { address: associatedBondingCurve } = deriveAssociatedBondingCurvePda(
    params.mint,
  );
  const { address: global } = deriveGlobalPda();
  const { address: feeRecipient } = deriveFeeRecipientPda();
  const { address: eventAuthority } = deriveEventAuthorityPda();

  const keys: AccountMeta[] = [
    { pubkey: global, isSigner: false, isWritable: false }, //                0
    { pubkey: feeRecipient, isSigner: false, isWritable: true }, //           1
    { pubkey: params.mint, isSigner: false, isWritable: false }, //           2
    { pubkey: bondingCurve, isSigner: false, isWritable: true }, //           3
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // 4
    { pubkey: params.userTokenAccount, isSigner: false, isWritable: true }, //5
    { pubkey: params.user, isSigner: true, isWritable: true }, //             6
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, //     7
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, //      8
    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false }, //           9
    { pubkey: eventAuthority, isSigner: false, isWritable: false }, //       10
    { pubkey: PUMPFUN_BONDING_CURVE_PROGRAM_ID, isSigner: false, isWritable: false }, // 11
  ];

  const data = concat(
    discHex(INSTRUCTION_DISCRIMINATORS.buy),
    encodeU64LE(params.solIn),
    encodeU64LE(params.maxSolCost),
  );

  return {
    programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID,
    keys,
    data,
  };
}
