import type { PublicKey } from '@ap3x/solana-core';
import type { Position } from './types.js';

export interface PortfolioReadApi {
  getPosition(wallet: PublicKey, mint: PublicKey): Promise<Position | null>;
  getAllPositions(wallet: PublicKey): Promise<Position[]>;
  getRealizedPnl(wallet: PublicKey, mint: PublicKey): Promise<bigint>;
  getUnrealizedPnl(wallet: PublicKey, mint: PublicKey, currentPriceLamports: bigint): Promise<bigint>;
}
