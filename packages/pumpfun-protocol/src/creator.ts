/**
 * `creator` — fetch the declared creator pubkey for a pump.fun mint.
 *
 * Pump.fun stamps the creator into the bonding-curve account at mint time.
 * The canonical on-chain source is `CurveState.creator`, so this helper is a
 * thin passthrough over {@link curveState} rather than a parallel PDA walk.
 *
 * Why a dedicated wrapper at all? Callers that only need the creator pubkey
 * shouldn't have to reason about the entire curve schema or remember which
 * typed field carries it. The one-liner here keeps the read surface uniform
 * (`metadata`, `holders`, `creator`, `curveState`, ...) and documents that
 * the authoritative creator lives on the bonding curve, not in the Metaplex
 * metadata `creators` array (which is a secondary signal — it exists for
 * royalty routing, and can in principle be empty or different).
 *
 * Every call is a fresh RPC round-trip. There is no caching; if you're
 * already holding a decoded `CurveState`, read `.creator` off it directly
 * instead of going through this helper.
 */

import type { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import { curveState } from './curve/state.js';

/**
 * Fetch and return the `creator` pubkey stored in the bonding-curve
 * account for `mint`.
 *
 * Delegates entirely to {@link curveState} — no separate PDA derivation, no
 * alternate RPC call. Propagates any {@link AccountLayoutError} from the
 * underlying decode if the curve account is missing or malformed.
 */
export async function creator(
  rpcPool: RpcPool,
  mint: PublicKey,
): Promise<PublicKey> {
  const state = await curveState(rpcPool, mint);
  return state.creator;
}
