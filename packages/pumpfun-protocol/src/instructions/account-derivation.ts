/**
 * Pump.fun account derivation helpers.
 *
 * Every instruction builder needs a small set of PDAs to populate its
 * account list:
 *
 *   - `bonding-curve` PDA (per mint)          — the curve account itself.
 *   - `associated-bonding-curve` PDA (per mint) — the curve's ATA for the
 *     mint, where the curve actually holds its token inventory.
 *   - `global` PDA                            — program-wide config.
 *   - `event-authority` PDA                   — authority required for the
 *     CPI event emission on every trade/create instruction.
 *   - `pool` PDA (per mint, PumpSwap)         — the AMM pool account.
 *
 * These helpers are pure and deterministic. All rely on
 * `findProgramAddress` from `@ap3x/solana-tx` (which uses `@noble/ed25519`
 * for the off-curve check). Zero ecosystem-SDK dependencies.
 *
 * The `bonding-curve` PDA helper is defined upstream in `curve/state.ts`
 * (Task 7) and re-exported here so instruction-builder code has a single
 * import surface for all derivations.
 */

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@ap3x/solana-spl';
import { deriveBondingCurvePda } from '../curve/state.js';
import { derivePumpSwapPoolPda } from '../pumpswap/pool-state.js';

// Re-export the per-mint PDA helpers that already live in the curve/pumpswap
// modules so instruction-builder callers have a single import surface for all
// pump.fun account derivations. DRY — do not redefine here.
export { deriveBondingCurvePda, derivePumpSwapPoolPda };

/**
 * Derive the associated token account where the bonding curve holds its
 * inventory of `mint`.
 *
 * This is the standard SPL ATA derivation, with the bonding-curve PDA as
 * owner (off-curve by construction):
 *
 *     seeds     = [bondingCurve, TOKEN_PROGRAM_ID, mint]
 *     programId = ASSOCIATED_TOKEN_PROGRAM_ID
 *
 * Computed directly with `findProgramAddress` rather than calling into
 * `solana-spl/getAssociatedTokenAddress` because the owner is a PDA and
 * we'd otherwise need `allowOwnerOffCurve = true`. Writing the seeds
 * inline keeps the intent visible at the call site.
 */
export function deriveAssociatedBondingCurvePda(
  mint: PublicKey,
): { address: PublicKey; bump: number } {
  const { address: bondingCurve } = deriveBondingCurvePda(mint);
  const seeds = [
    bondingCurve.toBuffer(),
    TOKEN_PROGRAM_ID.toBuffer(),
    mint.toBuffer(),
  ];
  return findProgramAddress(seeds, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/**
 * Derive the pump.fun global-config PDA.
 *
 *   seeds     = [b"global"]
 *   programId = PUMPFUN_BONDING_CURVE_PROGRAM_ID
 *
 * Required by every bonding-curve instruction (create / buy / sell).
 */
export function deriveGlobalPda(): { address: PublicKey; bump: number } {
  const seeds = [new TextEncoder().encode('global')];
  return findProgramAddress(seeds, PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

/**
 * Derive the pump.fun event-authority PDA.
 *
 *   seeds     = [b"__event_authority"]
 *   programId = PUMPFUN_BONDING_CURVE_PROGRAM_ID
 *
 * The event-authority is a PDA signer used for the CPI self-log pattern
 * every Anchor program that emits events relies on. It shows up as a
 * required account on create/buy/sell/set-params instructions.
 */
export function deriveEventAuthorityPda(): { address: PublicKey; bump: number } {
  const seeds = [new TextEncoder().encode('__event_authority')];
  return findProgramAddress(seeds, PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

// `derivePumpSwapPoolPda` is re-exported above from `pumpswap/pool-state.ts`.
// The seed recipe there is currently ASSUMED `[b"pool", mint.toBuffer()]`
// under the PumpSwap program; confirm during the live-sample checkpoint and
// update the single upstream definition if it drifts.
