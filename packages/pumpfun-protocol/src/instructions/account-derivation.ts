/**
 * Single import surface for pump.fun / PumpSwap account derivations. Seeds
 * match the vendored IDL (`@ap3x/pumpfun-events` `idl/`); the builders derive
 * the same addresses from the IDL directly, and the builder fixture tests
 * check both against real mainnet instructions.
 */

import type { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID, PUMPFUN_PUMPSWAP_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import { deriveBondingCurvePda, deriveBondingCurveV2Pda, deriveGlobalPda } from '../curve/state.js';
import {
  derivePoolAuthorityPda,
  derivePoolV2Pda,
  derivePumpSwapGlobalConfigPda,
  derivePumpSwapPoolPda,
} from '../pumpswap/pool-state.js';

export {
  deriveBondingCurvePda,
  deriveBondingCurveV2Pda,
  deriveGlobalPda,
  derivePoolAuthorityPda,
  derivePoolV2Pda,
  derivePumpSwapGlobalConfigPda,
  derivePumpSwapPoolPda,
};

const enc = new TextEncoder();
type Pda = { address: PublicKey; bump: number };

/** The bonding curve's token account (ATA of the curve PDA). */
export function deriveAssociatedBondingCurvePda(mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): Pda {
  const { address: bondingCurve } = deriveBondingCurvePda(mint);
  return findProgramAddress([bondingCurve.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function deriveMintAuthorityPda(): Pda {
  return findProgramAddress([enc.encode('mint-authority')], PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

/** Anchor event-CPI authority for either program (default: bonding curve). */
export function deriveEventAuthorityPda(programId: PublicKey = PUMPFUN_BONDING_CURVE_PROGRAM_ID): Pda {
  return findProgramAddress([enc.encode('__event_authority')], programId);
}

/** Bonding-curve creator fee vault: `["creator-vault", creator]`. */
export function deriveCreatorVaultPda(creator: PublicKey): Pda {
  return findProgramAddress([enc.encode('creator-vault'), creator.toBuffer()], PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

/** PumpSwap coin-creator vault authority: `["creator_vault", coin_creator]`. */
export function deriveCoinCreatorVaultAuthorityPda(coinCreator: PublicKey): Pda {
  return findProgramAddress([enc.encode('creator_vault'), coinCreator.toBuffer()], PUMPFUN_PUMPSWAP_PROGRAM_ID);
}

/** Per-user volume accumulator (either program; default: bonding curve). */
export function deriveUserVolumeAccumulatorPda(
  user: PublicKey,
  programId: PublicKey = PUMPFUN_BONDING_CURVE_PROGRAM_ID,
): Pda {
  return findProgramAddress([enc.encode('user_volume_accumulator'), user.toBuffer()], programId);
}
