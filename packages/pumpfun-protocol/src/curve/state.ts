/**
 * `curveState` — read and decode the pump.fun bonding-curve account.
 *
 * The bonding curve is a per-mint Anchor account owned by the pump.fun
 * bonding-curve program. It carries the reserves the program uses to quote
 * buys/sells and the "complete" flag that signals migration to PumpSwap.
 *
 * This module provides three layers:
 *
 *   1. {@link deriveBondingCurvePda} — pure PDA derivation from a mint.
 *   2. {@link decodeCurveState}      — pure Borsh decode of the account bytes.
 *   3. {@link curveState}            — one-shot RPC fetch + decode, stateless.
 *
 * Ecosystem-dep policy: only the substrate packages plus `@ap3x/pumpfun-events`
 * (for `BorshReader` and the program ID). No runtime dependency on web3.js,
 * spl-token, or Metaplex libraries.
 */

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import { BorshReader, PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import type { RpcPool } from '@ap3x/solana-connectivity';

/**
 * Decoded pump.fun bonding-curve state.
 *
 * Reserve fields are `bigint` because the on-chain layout is `u64`; a
 * bonding curve can legitimately hold more lamports than `Number.MAX_SAFE_INTEGER`
 * over its lifetime.
 *
 *   - `virtualSolReserves` / `virtualTokenReserves` — the curve's constant-product
 *     quote reserves (not physical custody).
 *   - `realSolReserves` / `realTokenReserves` — what the curve actually holds.
 *   - `complete` — `true` once the curve has migrated (no further trading on
 *     the bonding-curve program; liquidity lives on PumpSwap).
 *   - `createdAt` — unix seconds. Downcast from `i64`; a negative or post-2106
 *     timestamp is implausible for the lifetime of the program.
 */
export interface CurveState {
  mint: PublicKey;
  bondingCurve: PublicKey;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  createdAt: number;
}

/**
 * Thrown when raw account bytes fail to match the expected Anchor layout —
 * either the buffer is shorter than the minimum expected size, a field read
 * runs off the end, or the discriminator's tail bytes are malformed.
 *
 * Carries:
 *   - `expected` — a human-readable label for the layout we were trying to match
 *     (e.g. `"bonding-curve"`). Not the full schema, just a tag.
 *   - `observed` — the raw bytes that failed, so callers can dump them for a
 *     fixture-based regression test without the error having to stringify them.
 *   - `field`    — optional: the field name that was being read when the
 *     underlying decoder threw.
 */
export class AccountLayoutError extends Error {
  constructor(
    public readonly expected: string,
    public readonly observed: Uint8Array,
    public readonly field?: string,
  ) {
    super(`account layout mismatch: expected ${expected}${field ? ` (field: ${field})` : ''}`);
    this.name = 'AccountLayoutError';
  }
}

/**
 * Derive the bonding-curve PDA for a pump.fun mint.
 *
 * Seed recipe (matches the on-chain program):
 *   `[b"bonding-curve", mint.toBuffer()]`
 *
 * The search runs bumps 255 → 0; the first off-curve hash wins. Deterministic
 * and dependency-light (only `@noble/ed25519` via `@ap3x/solana-tx`).
 */
export function deriveBondingCurvePda(mint: PublicKey): { address: PublicKey; bump: number } {
  const seeds = [new TextEncoder().encode('bonding-curve'), mint.toBuffer()];
  return findProgramAddress(seeds, PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

/**
 * Minimum byte size of a bonding-curve account. Covers:
 *   8  bytes discriminator
 *   40 bytes = 5 * u64 (virtualToken, virtualSol, realToken, realSol, totalSupply)
 *   1  byte  complete flag
 *   32 bytes creator pubkey
 *   8  bytes created_at i64
 * = 89 bytes.
 *
 * Real accounts may have padding; we require at least this many bytes.
 */
const EXPECTED_CURVE_STATE_SIZE = 89;

/**
 * Decode raw bonding-curve account bytes into a {@link CurveState}.
 *
 * The 8-byte Anchor discriminator is skipped; callers that need to verify
 * the account type should compare it upstream (e.g. when wiring fixtures).
 * This function is deliberately forgiving of that step because a fetched
 * account is already known to belong to the bonding-curve program — the PDA
 * derivation in {@link curveState} guarantees it.
 *
 * Layout (Anchor `#[account]`):
 *   [0..8]    discriminator (skipped)
 *   [8..16]   virtualTokenReserves: u64 LE
 *   [16..24]  virtualSolReserves:   u64 LE
 *   [24..32]  realTokenReserves:    u64 LE
 *   [32..40]  realSolReserves:      u64 LE
 *   [40..48]  tokenTotalSupply:     u64 LE
 *   [48..49]  complete:             bool
 *   [49..81]  creator:              Pubkey (32 bytes)
 *   [81..89]  created_at:           i64 LE (unix seconds)
 */
export function decodeCurveState(bytes: Uint8Array, mint: PublicKey): CurveState {
  if (bytes.length < EXPECTED_CURVE_STATE_SIZE) {
    throw new AccountLayoutError('bonding-curve', bytes);
  }

  // Skip 8-byte discriminator.
  const r = new BorshReader(bytes.slice(8));
  try {
    const virtualTokenReserves = r.readU64LE();
    const virtualSolReserves = r.readU64LE();
    const realTokenReserves = r.readU64LE();
    const realSolReserves = r.readU64LE();
    const tokenTotalSupply = r.readU64LE();
    const complete = r.readBool();
    const creator = r.readPublicKey();
    const createdAt = Number(r.readI64LE());

    return {
      mint,
      bondingCurve: deriveBondingCurvePda(mint).address,
      virtualSolReserves,
      virtualTokenReserves,
      realSolReserves,
      realTokenReserves,
      tokenTotalSupply,
      complete,
      creator,
      createdAt,
    };
  } catch (err) {
    throw new AccountLayoutError('bonding-curve', bytes, (err as Error).message);
  }
}

/**
 * One-shot fetch: derive the bonding-curve PDA for `mint`, fetch the account
 * via `getAccountInfo`, and decode the returned bytes.
 *
 * Stateless — each call is an independent RPC round-trip. No caching, no
 * polling. Callers that need live updates subscribe via Geyser or wrap this
 * in their own poll loop.
 *
 * Throws {@link AccountLayoutError} if the account does not exist or the
 * returned bytes fail to decode.
 */
export async function curveState(rpcPool: RpcPool, mint: PublicKey): Promise<CurveState> {
  const { address: bondingCurvePda } = deriveBondingCurvePda(mint);
  const response = (await rpcPool.call('getAccountInfo', [
    bondingCurvePda.toBase58(),
    { encoding: 'base64' },
  ])) as { value: { data: [string, string] } | null };

  if (!response?.value?.data) {
    throw new AccountLayoutError('bonding-curve', new Uint8Array(), 'account not found');
  }

  const [base64Data] = response.value.data;
  const bytes = Uint8Array.from(Buffer.from(base64Data, 'base64'));
  return decodeCurveState(bytes, mint);
}
