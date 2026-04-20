import { PublicKey } from '@ap3x/solana-core';

/**
 * Pump.fun bonding curve program ID.
 * Mainnet: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *
 * Validate against the nightly diag probe — if pump.fun redeploys to a
 * different address, the diag fails fast before production breaks.
 */
export const PUMPFUN_BONDING_CURVE_PROGRAM_ID = PublicKey.fromBase58(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
);

/**
 * PumpSwap AMM program ID.
 * Mainnet: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 *
 * Confirmed during T4 live-sample verification checkpoint. If this value
 * needs updating post-deployment, fix here and rerun T4 + T5 fixture capture.
 */
export const PUMPFUN_PUMPSWAP_PROGRAM_ID = PublicKey.fromBase58(
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
);
