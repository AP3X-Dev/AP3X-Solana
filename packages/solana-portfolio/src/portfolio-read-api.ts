import type { PublicKey } from '@ap3x/solana-core';
import type { Position, RealizedPnlStatus } from './types.js';

export interface PortfolioReadApi {
  getPosition(wallet: PublicKey, mint: PublicKey): Promise<Position | null>;
  getAllPositions(wallet: PublicKey): Promise<Position[]>;
  getRealizedPnl(wallet: PublicKey, mint: PublicKey): Promise<bigint>;
  getRealizedPnlStatus?(wallet: PublicKey, mint: PublicKey): Promise<RealizedPnlStatus>;
  getUnrealizedPnl(wallet: PublicKey, mint: PublicKey, currentPriceLamports: bigint): Promise<bigint>;
}
