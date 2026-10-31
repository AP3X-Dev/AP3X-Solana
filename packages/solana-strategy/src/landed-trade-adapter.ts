// ---------------------------------------------------------------------------
// landed-trade-adapter — runtime-owned cycle break between executor and portfolio
//
// StrategyRuntime calls `adaptToLandedTrades(result, opts)` after
// `executor.submit(...)` returns, then loops the result(s) into
// `portfolio.applyLandedTrade(...)`.
//
// Only `landed` results produce trades; all other variants return [].
// ---------------------------------------------------------------------------

import { PublicKey, rpcU64 } from '@ap3x/solana-core';
import type { ExecutionResult } from '@ap3x/solana-executor';
import type { LandedTrade } from '@ap3x/solana-portfolio';

// ---------------------------------------------------------------------------
// RpcPoolLike — minimal call surface needed here.
//
// Using this narrow interface instead of `RpcPool` directly avoids a hard
// import of the full connectivity package and keeps the test fake trivial.
// Same pattern as `FeeEstimatorLike` in `@ap3x/solana-executor`.
// ---------------------------------------------------------------------------

export interface RpcPoolLike {
  call(method: string, params: unknown[] | Record<string, unknown>, opts?: unknown): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Internal typed interfaces for the Solana JSON-RPC getTransaction response.
// Avoids `any` casts throughout the parsing logic.
// ---------------------------------------------------------------------------

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

interface TransactionMeta {
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
  err: unknown;
  logMessages?: string[];
  loadedAddresses?: { writable?: string[]; readonly?: string[] };
}

interface TransactionMessage {
  accountKeys: string[];
  instructions: unknown[];
  recentBlockhash: string;
}

interface SolanaTransaction {
  message: TransactionMessage;
  signatures: string[];
}

interface SolanaTransactionResponse {
  slot: number;
  version: number | 'legacy';
  meta: TransactionMeta | null;
  transaction: SolanaTransaction;
}

// ---------------------------------------------------------------------------
// Type guard — narrows `unknown` from rpcPool.call to our typed shape.
// ---------------------------------------------------------------------------

function isSolanaTransactionResponse(v: unknown): v is SolanaTransactionResponse {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (!obj['transaction'] || typeof obj['transaction'] !== 'object') return false;
  const tx = obj['transaction'] as Record<string, unknown>;
  if (!tx['message'] || typeof tx['message'] !== 'object') return false;
  return true;
}

// ---------------------------------------------------------------------------
// AdaptOpts
// ---------------------------------------------------------------------------

export interface AdaptOpts {
  rpcPool: RpcPoolLike;
  walletAddress: PublicKey;
}

// ---------------------------------------------------------------------------
// adaptToLandedTrades — public API
// ---------------------------------------------------------------------------

/**
 * Adapts a `landed` ExecutionResult into one or more LandedTrade records by
 * fetching the transaction via RPC and extracting per-mint deltas + SOL flow
 * for the target wallet.
 *
 * `dropped`, `timeout`, `reverted`, and `rejected` results produce zero trades
 * and do not trigger any RPC call.
 *
 * Note on solFlowLamports: this is the wallet's NET SOL delta
 * (postBalance - preBalance). The fee is already baked into that delta
 * naturally (the fee deducts from the payer's balance before posting).
 * `feeLamports` is extracted separately for telemetry only — callers must
 * not add it back in to avoid double-counting.
 */
export async function adaptToLandedTrades(
  result: ExecutionResult,
  opts: AdaptOpts,
): Promise<LandedTrade[]> {
  if (result.kind !== 'landed') return [];

  const raw = await opts.rpcPool.call('getTransaction', [
    result.signature,
    { maxSupportedTransactionVersion: 1, encoding: 'json' },
  ]);

  if (!isSolanaTransactionResponse(raw) || !raw.meta) return [];

  // Destructure meta after the null guard so TypeScript knows it is non-null.
  const { meta, transaction } = raw;
  if (meta.err !== null) throw new Error('Landed receipt execution is failed or unproven');
  if (!Number.isSafeInteger(raw.slot) || raw.slot < 0 || transaction.signatures?.[0] !== result.signature || raw.slot !== result.slot)
    throw new Error('Landed receipt signature/slot identity mismatch');
  const walletStr = opts.walletAddress.toBase58();

  // -------------------------------------------------------------------------
  // SOL delta for our wallet
  // -------------------------------------------------------------------------

  const keyGroups = [transaction.message.accountKeys, meta.loadedAddresses?.writable ?? [], meta.loadedAddresses?.readonly ?? []];
  if (keyGroups.some(group => !Array.isArray(group) || group.some(k => typeof k !== 'string' || !k)))
    throw new Error('Invalid receipt account keys');
  const keys = keyGroups.flat();
  if (!keys.length || new Set(keys).size !== keys.length) throw new Error('Invalid or duplicate receipt account keys');
  const accountIdx = keys.indexOf(walletStr);
  const fee = rpcU64(meta.fee, 'Network fee');
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)
    || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length)
    throw new Error('Native balance recording does not match receipt account keys');
  let solDelta = 0n;
  const nativeBefore = meta.preBalances.map(v => rpcU64(v, 'Before native balance'));
  const nativeAfter = meta.postBalances.map(v => rpcU64(v, 'After native balance'));
  if (accountIdx >= 0) {
    const before = nativeBefore[accountIdx]!;
    const after = nativeAfter[accountIdx]!;
    solDelta = after - before;
  }

  // -------------------------------------------------------------------------
  // Token deltas for our wallet — merge pre and post token balance arrays
  // -------------------------------------------------------------------------

  if (!Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances))
    throw new Error('Token balance recording is unavailable');
  const pre = meta.preTokenBalances;
  const post = meta.postTokenBalances;

  const deltasByMint = new Map<string, bigint>();
  for (const [rows, sign] of [[pre, -1n], [post, 1n]] as const) {
    const accounts = new Set<number>();
    for (const b of rows) {
      if (!b || typeof b.owner !== 'string' || !b.owner || typeof b.mint !== 'string' || !b.mint
        || !Number.isSafeInteger(b.accountIndex) || b.accountIndex < 0 || b.accountIndex >= keys.length || accounts.has(b.accountIndex))
        throw new Error('Invalid or duplicate token account balance');
      accounts.add(b.accountIndex);
      if (typeof b.uiTokenAmount?.amount !== 'string') throw new Error('Token raw quantity must be a string');
      const amount = rpcU64(b.uiTokenAmount.amount, 'Token raw quantity');
      if (b.owner !== walletStr) continue;
      deltasByMint.set(b.mint, (deltasByMint.get(b.mint) ?? 0n) + sign * amount);
    }
  }

  // -------------------------------------------------------------------------
  // Assemble LandedTrade records — skip zero deltas
  // -------------------------------------------------------------------------

  const trades: LandedTrade[] = [];
  for (const [mintStr, delta] of deltasByMint) {
    if (delta === 0n) continue;
    trades.push({
      signature: result.signature,
      slot: result.slot,
      wallet: opts.walletAddress,
      mint: PublicKey.fromBase58(mintStr),
      amountDelta: delta,
      solFlowLamports: solDelta,
      feeLamports: fee,
      source: 'executor',
    });
  }

  return trades;
}
