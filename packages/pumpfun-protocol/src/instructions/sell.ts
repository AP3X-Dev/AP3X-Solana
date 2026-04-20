/**
 * `buildSell` — pure instruction builder for pump.fun's bonding-curve
 * Sell instruction.
 *
 * Burn-for-SOL: send `tokenAmount` units of the pump.fun token into the
 * bonding curve in exchange for lamports. Symmetric to {@link buildBuy};
 * only the direction, discriminator, and argument semantics change.
 *
 * Pure: returns `{ programId, keys, data }`. No signing, no network. Hand the
 * result to `@ap3x/solana-tx.assemble` with a signer list that covers `user`.
 *
 * -----------------------------------------------------------------------
 * BEST-EFFORT ASSUMPTIONS (unverified, flagged for mainnet confirmation):
 * -----------------------------------------------------------------------
 *
 *   1. **Account layout.** The 12-account positional layout below mirrors
 *      `buildBuy` — pump.fun's Sell instruction shares the same account
 *      shape in published third-party SDKs. Without a captured mainnet Sell
 *      transaction we cannot confirm positions or writable flags. Nightly
 *      diag + per-variant fixture tests surface drift once a Helius key is
 *      available.
 *
 *   2. **Fee-recipient PDA seed.** Derived from
 *      `[b"fee_recipient", PUMPFUN_BONDING_CURVE_PROGRAM_ID]` — see the
 *      matching note in `buy.ts`.
 *
 *   3. **Sell instruction discriminator.** Sourced from
 *      `INSTRUCTION_DISCRIMINATORS.sell` (Anchor `sha256("global:sell")[..8]`).
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
 *    6  user                     (signer, writable)  — seller, receives SOL proceeds
 *    7  system program
 *    8  token program
 *    9  sysvar rent
 *   10  event-authority PDA      (readonly)          — CPI self-log authority
 *   11  bonding-curve program (self)                  — required by Anchor event CPI
 *
 * Instruction data:
 *   [0..8]   discriminator  (hex `33e685a4017f83ad` → `INSTRUCTION_DISCRIMINATORS.sell`)
 *   [8..16]  tokenAmount    u64 LE — base-unit tokens being sold
 *   [16..24] minSolOut      u64 LE — slippage floor in lamports
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
import type { SellParams } from './params.js';

/**
 * Sysvar rent account. Same rationale as in `buy.ts` — inlined here rather
 * than imported because `@ap3x/solana-core` doesn't ship sysvar identifiers.
 */
const SYSVAR_RENT = /* @__PURE__ */ PublicKey.fromBase58(
  'SysvarRent111111111111111111111111111111111',
);

/**
 * Build the raw `Instruction` for pump.fun's bonding-curve Sell.
 *
 * Pure — returns `{ programId, keys, data }`.
 *
 * Validates amount semantics:
 *   - `tokenAmount > 0n`  — zero-token sells would have nothing to sell.
 *   - `minSolOut >= 0n`   — negative lamport floors are meaningless; `0n`
 *                            is valid (caller is willing to eat any price).
 *
 * Note: unlike Buy, the slippage floor can legitimately be `0n` — that's a
 * "market sell at any price" pattern used by liquidation strategies. The
 * program always enforces its own rails (no under-collateralized sells).
 *
 * @throws TypeError when `tokenAmount <= 0n` or `minSolOut < 0n`.
 */
export function buildSell(params: SellParams): Instruction {
  if (params.tokenAmount <= 0n) {
    throw new TypeError('SellParams.tokenAmount must be > 0');
  }
  if (params.minSolOut < 0n) {
    throw new TypeError('SellParams.minSolOut must be >= 0');
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
    discHex(INSTRUCTION_DISCRIMINATORS.sell),
    encodeU64LE(params.tokenAmount),
    encodeU64LE(params.minSolOut),
  );

  return {
    programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID,
    keys,
    data,
  };
}
