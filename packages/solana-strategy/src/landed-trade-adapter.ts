// ---------------------------------------------------------------------------
// landed-trade-adapter — runtime-owned cycle break between executor and portfolio
//
// StrategyRuntime calls `adaptToLandedTrades(result, opts)` after
// `executor.submit(...)` returns, then loops the result(s) into
// `portfolio.applyLandedTrade(...)`.
//
// Only `landed` results produce trades; all other variants return [].
// ---------------------------------------------------------------------------

import { PublicKey } from '@ap3x/solana-core';
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
  if (!('transaction' in obj) || typeof obj['transaction'] !== 'object') return false;
  const tx = obj['transaction'] as Record<string, unknown>;
  if (!('message' in tx) || typeof tx['message'] !== 'object') return false;
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
    { maxSupportedTransactionVersion: 0, encoding: 'json' },
  ]);

  if (!isSolanaTransactionResponse(raw) || raw.meta === null) return [];

  // Destructure meta after the null guard so TypeScript knows it is non-null.
  const { meta, transaction } = raw;
  const walletStr = opts.walletAddress.toBase58();

  // -------------------------------------------------------------------------
  // SOL delta for our wallet
  // -------------------------------------------------------------------------

  const accountIdx = transaction.message.accountKeys.indexOf(walletStr);
  const fee = BigInt(meta.fee ?? 0);
  let solDelta = 0n;
  if (accountIdx >= 0) {
    const before = BigInt(meta.preBalances[accountIdx] ?? 0);
    const after = BigInt(meta.postBalances[accountIdx] ?? 0);
    solDelta = after - before;
  }

  // -------------------------------------------------------------------------
  // Token deltas for our wallet — merge pre and post token balance arrays
  // -------------------------------------------------------------------------

  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];

  const deltasByMint = new Map<string, bigint>();
  const seen = new Set<string>();

  // Post balances — may be increase (buy) or decrease (sell)
  for (const b of post) {
    if (b.owner !== walletStr) continue;
    seen.add(b.mint);
    const preAmt = BigInt(
      pre.find((p) => p.owner === walletStr && p.mint === b.mint)?.uiTokenAmount?.amount ?? '0',
    );
    const postAmt = BigInt(b.uiTokenAmount?.amount ?? '0');
    deltasByMint.set(b.mint, postAmt - preAmt);
  }

  // Pre-only balances — account was closed (full sell)
  for (const b of pre) {
    if (b.owner !== walletStr || seen.has(b.mint)) continue;
    deltasByMint.set(b.mint, -BigInt(b.uiTokenAmount?.amount ?? '0'));
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
