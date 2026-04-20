/**
 * `holders` — enumerate the top-N holders of a pump.fun mint.
 *
 * This is a thin vertical-facing wrapper over the substrate's SPL holder
 * queries. The choice between `getTokenLargestAccounts` (fast, hard-capped at
 * 20 entries by the validator) and `getTokenAccountsByMint` (full scan via
 * `getProgramAccounts` — heavy, paginating via sort-then-slice in memory) is
 * driven purely by the caller's `limit`:
 *
 *   - `limit <= 20` — use `getTokenLargestAccounts`. One RPC call, O(20)
 *     memory, no validator-side load beyond what the built-in index already
 *     serves.
 *   - `limit >  20` — fall through to `getTokenAccountsByMint`. Decodes every
 *     token account for the mint and sorts by balance. Slow on popular mints;
 *     callers asking for hundreds of holders should expect validator throttling
 *     and wire an indexer instead. See `holder-queries.ts` docs in
 *     `@ap3x/solana-spl` for the full caveats.
 *
 * `pctOfSupply` is a best-effort `number` in `[0, 1]`. It deliberately takes
 * `totalSupply` as a parameter (rather than re-fetching the mint) so callers
 * can cache the supply themselves — pump.fun tokens have a fixed total supply
 * over the bonding-curve lifecycle, so the refetch would be wasted.
 *
 * When `totalSupply === 0n` we return `0` rather than dividing by zero; this
 * keeps the function total on degenerate inputs (a brand-new or burned-out
 * mint) instead of emitting `NaN` that would poison downstream math.
 *
 * Precision note: `Number(bigint) / Number(bigint)` loses precision past
 * 2^53. For pump.fun's fixed 1e15-base-unit supply that's a ~53-bit ratio,
 * which rounds in the sixth significant figure — fine for a percentage
 * display, not fine for settlement math. Callers that need exact ratios
 * should compute them directly from `balance` and `totalSupply` bigints.
 */

import type { PublicKey } from '@ap3x/solana-core';
import {
  getTokenAccountsByMint,
  getTokenLargestAccounts,
} from '@ap3x/solana-spl';
import type { RpcPool } from '@ap3x/solana-connectivity';

/**
 * One holder's slice of the mint. `balance` is raw base units (no decimal
 * scaling); `pctOfSupply` is a convenience float in `[0, 1]`.
 */
export interface HolderSummary {
  address: PublicKey;
  balance: bigint;
  pctOfSupply: number;
}

/**
 * Convert a (balance, supply) bigint pair into a `[0, 1]` float. Returns
 * `0` if supply is zero — the ratio is undefined there, and emitting `NaN`
 * would propagate into every downstream calculation.
 */
function pct(balance: bigint, totalSupply: bigint): number {
  if (totalSupply === 0n) return 0;
  return Number(balance) / Number(totalSupply);
}

/**
 * Return up to `limit` holders of `mint`, sorted by balance descending.
 *
 * The RPC path is picked by `limit`:
 *   - `<= 20` → `getTokenLargestAccounts` (one round-trip, indexed on the
 *     validator side, returns pre-sorted).
 *   - `> 20`  → `getTokenAccountsByMint` (full scan, sorted in memory). See
 *     module docstring for performance caveats.
 *
 * `pctOfSupply` uses `totalSupply` as passed — callers already have it from
 * `curveState.tokenTotalSupply` for pump.fun mints. Zero supply returns
 * `pctOfSupply = 0` across every entry rather than `NaN`.
 */
export async function holders(
  rpcPool: RpcPool,
  mint: PublicKey,
  limit: number,
  totalSupply: bigint,
): Promise<HolderSummary[]> {
  if (limit <= 20) {
    const largest = await getTokenLargestAccounts(rpcPool, mint);
    return largest.slice(0, limit).map((a) => ({
      address: a.address,
      balance: a.amount,
      pctOfSupply: pct(a.amount, totalSupply),
    }));
  }

  // limit > 20 — fall back to the full scan + in-memory sort.
  const all = await getTokenAccountsByMint(rpcPool, mint);
  return all
    .map((h) => ({
      address: h.pubkey,
      balance: h.account.amount,
      pctOfSupply: pct(h.account.amount, totalSupply),
    }))
    .sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0))
    .slice(0, limit);
}
