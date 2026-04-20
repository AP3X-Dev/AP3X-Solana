/**
 * `pumpSwapPoolState` — read and decode a PumpSwap AMM pool account.
 *
 * Mirrors `curve/state.ts` for PumpSwap. The PumpSwap AMM is the constant-product
 * pool program that pump.fun bonding curves graduate to on completion. Each
 * pool is a per-mint Anchor account owned by the PumpSwap program and carries
 * the reserves the program uses to quote swaps plus admin / LP metadata.
 *
 * Three layers, same shape as the curve module:
 *
 *   1. {@link derivePumpSwapPoolPda}     — pure PDA derivation from a mint.
 *   2. {@link decodePumpSwapPoolState}   — pure Borsh decode of the account bytes.
 *   3. {@link pumpSwapPoolState}         — one-shot RPC fetch + decode, stateless.
 *
 * LAYOUT / SEED ASSUMPTIONS (unverified — no live sample yet):
 *   - PDA seeds: `[b"pool", mint.toBuffer()]` under `PUMPFUN_PUMPSWAP_PROGRAM_ID`.
 *     This matches the decoder's convention but is unconfirmed without a
 *     captured pool account. Revisit during the T4 fixture capture checkpoint
 *     — if PumpSwap uses a different seed recipe (e.g. involves both mints,
 *     or a different label), update here and regenerate fixtures.
 *   - Account layout: Anchor 8-byte discriminator + Borsh fields in the order
 *     declared in {@link decodePumpSwapPoolState}. The `authorities` field is
 *     encoded as two consecutive Anchor `Option<Pubkey>` values (1-byte tag
 *     plus optional 32-byte key).
 *   - Any mismatch surfaces as {@link AccountLayoutError}, never a silent
 *     mis-decode; the `observed` bytes are preserved for fixture regression.
 *
 * Ecosystem-dep policy: only substrate packages plus `@ap3x/pumpfun-events`
 * (for `BorshReader` and the program ID). No runtime dependency on web3.js,
 * spl-token, or Metaplex libraries.
 */

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import { BorshReader, PUMPFUN_PUMPSWAP_PROGRAM_ID } from '@ap3x/pumpfun-events';
import type { RpcPool } from '@ap3x/solana-connectivity';
import { AccountLayoutError } from '../curve/state.js';

/**
 * Decoded PumpSwap AMM pool state.
 *
 * Reserve fields are `bigint` because the on-chain layout is `u64`; a pool
 * can legitimately hold more lamports / token units than `Number.MAX_SAFE_INTEGER`.
 *
 *   - `pool` — the pool account address (typically a PDA of the base mint).
 *   - `baseMint` / `quoteMint` — the two sides of the constant-product pair.
 *     For graduated pump.fun tokens, `baseMint` is the pump token and
 *     `quoteMint` is wrapped SOL.
 *   - `baseReserves` / `quoteReserves` — the pool's actual holdings of each
 *     mint; these drive swap quotes via `x * y = k`.
 *   - `lpMint` — the LP token mint minted when liquidity is added.
 *   - `feeBasisPoints` — swap fee in basis points (e.g. 30 = 0.30%). Read as
 *     `u16`; PumpSwap has no use case for values over 65_535 bps.
 *   - `authorities.freeze` / `authorities.update` — optional admin keys.
 *     Each is an Anchor `Option<Pubkey>`; absence means the capability is
 *     renounced or not set.
 */
export interface PumpSwapPoolState {
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseReserves: bigint;
  quoteReserves: bigint;
  lpMint: PublicKey;
  feeBasisPoints: number;
  authorities: { freeze?: PublicKey; update?: PublicKey };
}

/**
 * Derive the PumpSwap pool PDA for a base mint.
 *
 * Seed recipe (ASSUMED — seed unverified without live sample; confirm during
 * fixture capture):
 *   `[b"pool", mint.toBuffer()]`
 *
 * The search runs bumps 255 → 0; the first off-curve hash wins. Deterministic
 * and dependency-light (only `@noble/ed25519` via `@ap3x/solana-tx`).
 */
export function derivePumpSwapPoolPda(mint: PublicKey): { address: PublicKey; bump: number } {
  const seeds = [new TextEncoder().encode('pool'), mint.toBuffer()];
  return findProgramAddress(seeds, PUMPFUN_PUMPSWAP_PROGRAM_ID);
}

/**
 * Minimum byte size of a PumpSwap pool account (both Option<> authorities as None):
 *   8  bytes  discriminator
 *   32 bytes  baseMint
 *   32 bytes  quoteMint
 *   8  bytes  baseReserves  u64
 *   8  bytes  quoteReserves u64
 *   32 bytes  lpMint
 *   2  bytes  feeBasisPoints u16
 *   1  byte   Option<freeze> tag (None → 1 byte total)
 *   1  byte   Option<update> tag
 *   ----
 *   = 124 bytes minimum.
 *
 * If either authority is `Some`, the account is larger by 32 bytes per present
 * authority. We only enforce the minimum — real accounts may carry padding.
 */
const EXPECTED_POOL_STATE_MIN_SIZE = 124;

/**
 * Decode raw PumpSwap pool account bytes into a {@link PumpSwapPoolState}.
 *
 * The 8-byte Anchor discriminator is skipped; callers that need to verify
 * the account type should compare it upstream.
 *
 * Layout (ASSUMED Anchor `#[account]` — unverified without captured sample):
 *   [0..8]    discriminator (skipped)
 *   [8..40]   baseMint        Pubkey
 *   [40..72]  quoteMint       Pubkey
 *   [72..80]  baseReserves    u64 LE
 *   [80..88]  quoteReserves   u64 LE
 *   [88..120] lpMint          Pubkey
 *   [120..122] feeBasisPoints u16 LE
 *   [122..]   freeze          Option<Pubkey>  (1-byte tag, then 32 bytes if Some)
 *   [...]     update          Option<Pubkey>  (1-byte tag, then 32 bytes if Some)
 */
export function decodePumpSwapPoolState(bytes: Uint8Array, pool: PublicKey): PumpSwapPoolState {
  if (bytes.length < EXPECTED_POOL_STATE_MIN_SIZE) {
    throw new AccountLayoutError('pumpswap-pool', bytes);
  }

  // Skip 8-byte discriminator.
  const r = new BorshReader(bytes.slice(8));
  try {
    const baseMint = r.readPublicKey();
    const quoteMint = r.readPublicKey();
    const baseReserves = r.readU64LE();
    const quoteReserves = r.readU64LE();
    const lpMint = r.readPublicKey();
    const feeBasisPoints = r.readU16LE();
    const freeze = r.readOption((reader) => reader.readPublicKey());
    const update = r.readOption((reader) => reader.readPublicKey());

    const authorities: { freeze?: PublicKey; update?: PublicKey } = {};
    if (freeze) authorities.freeze = freeze;
    if (update) authorities.update = update;

    return {
      pool,
      baseMint,
      quoteMint,
      baseReserves,
      quoteReserves,
      lpMint,
      feeBasisPoints,
      authorities,
    };
  } catch (err) {
    throw new AccountLayoutError('pumpswap-pool', bytes, (err as Error).message);
  }
}

/**
 * One-shot fetch: given a pool address, fetch the account via `getAccountInfo`
 * and decode the returned bytes.
 *
 * Callers that have a base mint rather than a pool address should derive the
 * PDA via {@link derivePumpSwapPoolPda} first. We don't re-derive here because
 * (a) the seed recipe is currently unverified and (b) callers that already
 * have a live pool address from an on-chain log should use it directly.
 *
 * Stateless — each call is an independent RPC round-trip. No caching, no
 * polling. Callers that need live updates subscribe via Geyser or wrap this
 * in their own poll loop.
 *
 * Throws {@link AccountLayoutError} if the account does not exist or the
 * returned bytes fail to decode.
 */
export async function pumpSwapPoolState(
  rpcPool: RpcPool,
  pool: PublicKey,
): Promise<PumpSwapPoolState> {
  const response = (await rpcPool.call('getAccountInfo', [
    pool.toBase58(),
    { encoding: 'base64' },
  ])) as { value: { data: [string, string] } | null };

  if (!response?.value?.data) {
    throw new AccountLayoutError('pumpswap-pool', new Uint8Array(), 'account not found');
  }

  const [base64Data] = response.value.data;
  const bytes = Uint8Array.from(Buffer.from(base64Data, 'base64'));
  return decodePumpSwapPoolState(bytes, pool);
}
