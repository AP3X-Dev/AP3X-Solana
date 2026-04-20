/**
 * `PumpFunClient` — convenience class that composes the protocol package's
 * read/write surface behind a single constructor.
 *
 * Every method is a pure delegate to the module-level export of the same
 * name — no caching, no per-instance state beyond the constructor-injected
 * `RpcPool` + `MetadataResolver`, no policy decisions. Strategies that want
 * the functional surface import the module-level helpers directly;
 * strategies that prefer a single handle carrying the RPC pool and the
 * Metaplex resolver use this class. Both styles produce byte-identical
 * instructions and read-side values.
 *
 * This keeps `PumpFunClient` trivially testable (the delegated helpers
 * already have unit coverage) and avoids hiding retry / cache logic inside
 * a class boundary. If any of that ever needs to live somewhere, it should
 * land as a new layer over this class rather than inside it.
 */

import type { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { MetadataResolver } from '@ap3x/solana-metaplex';
import type { Instruction } from '@ap3x/solana-tx';
import { curveState, type CurveState } from './curve/state.js';
import {
  pumpSwapPoolState,
  type PumpSwapPoolState,
} from './pumpswap/pool-state.js';
import { metadata, type PumpFunMetadata } from './metadata.js';
import { holders, type HolderSummary } from './holders.js';
import { creator } from './creator.js';
import {
  fetchRecentTrades,
  type UnifiedTrade,
  type RecentTradesWindow,
} from './fetch-recent-trades.js';
import {
  buy,
  sell,
  type UnifiedBuyParams,
  type UnifiedSellParams,
} from './routing.js';

/**
 * Convenience wrapper that binds an {@link RpcPool} and a
 * {@link MetadataResolver} to every read/write call in the protocol
 * surface. Thin by design — every method body is one delegated call.
 */
export class PumpFunClient {
  constructor(
    private readonly rpcPool: RpcPool,
    private readonly metadataResolver: MetadataResolver,
  ) {}

  /** Delegates to {@link curveState}. */
  curveState(mint: PublicKey): Promise<CurveState> {
    return curveState(this.rpcPool, mint);
  }

  /** Delegates to {@link pumpSwapPoolState}. */
  pumpSwapPoolState(pool: PublicKey): Promise<PumpSwapPoolState> {
    return pumpSwapPoolState(this.rpcPool, pool);
  }

  /** Delegates to {@link metadata} using the injected resolver. */
  metadata(mint: PublicKey): Promise<PumpFunMetadata> {
    return metadata(this.rpcPool, this.metadataResolver, mint);
  }

  /** Delegates to {@link holders}. */
  holders(
    mint: PublicKey,
    limit: number,
    totalSupply: bigint,
  ): Promise<HolderSummary[]> {
    return holders(this.rpcPool, mint, limit, totalSupply);
  }

  /** Delegates to {@link creator}. */
  creator(mint: PublicKey): Promise<PublicKey> {
    return creator(this.rpcPool, mint);
  }

  /** Delegates to {@link fetchRecentTrades}. */
  fetchRecentTrades(
    mint: PublicKey,
    window: RecentTradesWindow,
  ): Promise<UnifiedTrade[]> {
    return fetchRecentTrades(this.rpcPool, mint, window);
  }

  /** Delegates to {@link buy}. */
  buy(mint: PublicKey, params: UnifiedBuyParams): Promise<Instruction> {
    return buy(this.rpcPool, mint, params);
  }

  /** Delegates to {@link sell}. */
  sell(mint: PublicKey, params: UnifiedSellParams): Promise<Instruction> {
    return sell(this.rpcPool, mint, params);
  }
}
