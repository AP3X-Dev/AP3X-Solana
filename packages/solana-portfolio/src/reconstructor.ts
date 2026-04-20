/**
 * CostBasisReconstructor — cold-start cost-basis reconstruction.
 *
 * Implements the 4-step algorithm from PRP-02 spec Section 3.4:
 *
 *   1. Pull recent signatures for the wallet via `getSignaturesForAddress`,
 *      newest-first, capped at `lookbackDays` (default 90).
 *   2. For each signature, fetch the full transaction and identify inflows of
 *      `mint` into `wallet` via pre/post-token balances.
 *   3. Classify each inflow. Registered swap tracers win first; the SOL-outflow
 *      heuristic is the fallback. Accumulate lots newest-first. Stop as soon as
 *      `accounted >= currentBalance`.
 *   4. If the loop exhausts the signature window without covering
 *      `currentBalance`, emit `cost-basis-incomplete` and push one
 *      `cold-start-unresolved` lot for the remainder so downstream accounting
 *      can still reduce against it (with `basisUnresolved: true` surfaced on
 *      any realised PnL event).
 *
 * Design notes:
 *
 *   - RPC response shapes are narrow local interfaces rather than `any`. The
 *     pool returns `unknown`; we cast to these interfaces after the call. They
 *     are deliberately lenient on numeric types — Solana nodes return
 *     lamport balances as JSON numbers, but our test fixtures pass bigints.
 *     `BigInt(…)` normalises both.
 *   - The cutoff check uses `blockTime` (Unix seconds). Signatures without a
 *     `blockTime` (rare, only on historical / pruned entries) are *not*
 *     skipped — we err on the side of walking them rather than silently
 *     truncating.
 *   - `oldestSlotWalked` tracks the oldest slot we actually *fetched* a tx
 *     for. It's zero-filled only when no signature was processed at all (so
 *     the emitted event's slot isn't `Number.MAX_SAFE_INTEGER`).
 *   - Zero / negative token deltas short-circuit — only strict inflows are
 *     candidates for a lot.
 */

import { EventEmitter } from 'node:events';

import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';

import type { ParsedTransaction, SwapTracerRegistry } from './swap-tracer.js';
import type { CostBasisIncompleteEvent, Lot } from './types.js';

// ---------------------------------------------------------------------------
// RPC response shapes
// ---------------------------------------------------------------------------
//
// Narrow interfaces for the two JSON-RPC responses this module consumes. The
// upstream `RpcPool.call()` returns `unknown`; we cast to these after the
// call. Fields are typed leniently for numeric values so the same shapes hold
// for real RPC responses (numbers) and test fixtures (bigints).

interface SignatureEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
}

interface TokenBalanceEntry {
  accountIndex?: number;
  owner?: string;
  mint?: string;
  uiTokenAmount?: { amount?: string };
}

interface RpcInstruction {
  programIdIndex: number;
  accounts?: number[];
  data?: string;
}

interface RpcTransactionMessage {
  accountKeys: string[];
  instructions?: RpcInstruction[];
}

interface RpcTransactionBody {
  message: RpcTransactionMessage;
  signatures?: string[];
}

interface RpcTransactionMeta {
  preBalances?: Array<number | bigint>;
  postBalances?: Array<number | bigint>;
  fee?: number | bigint;
  preTokenBalances?: TokenBalanceEntry[];
  postTokenBalances?: TokenBalanceEntry[];
  logMessages?: string[];
}

interface RpcTransaction {
  slot: number;
  meta: RpcTransactionMeta;
  transaction: RpcTransactionBody;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CostBasisReconstructorOpts {
  rpcPool: RpcPool;
  tracerRegistry: SwapTracerRegistry;
  lookbackDays?: number;
}

export interface CostBasisReconstructorEvents {
  'cost-basis-incomplete': (event: CostBasisIncompleteEvent) => void;
}

// ---------------------------------------------------------------------------
// CostBasisReconstructor
// ---------------------------------------------------------------------------

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_SIG_PAGE_SIZE = 1000;

export class CostBasisReconstructor extends EventEmitter {
  readonly #rpcPool: RpcPool;
  readonly #tracerRegistry: SwapTracerRegistry;
  readonly #lookbackDays: number;

  constructor(opts: CostBasisReconstructorOpts) {
    super();
    this.#rpcPool = opts.rpcPool;
    this.#tracerRegistry = opts.tracerRegistry;
    this.#lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  }

  override on<E extends keyof CostBasisReconstructorEvents>(
    event: E,
    handler: CostBasisReconstructorEvents[E],
  ): this;
  override on(event: string | symbol, handler: (...args: unknown[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  async reconstruct(
    wallet: PublicKey,
    mint: PublicKey,
    currentBalance: bigint,
  ): Promise<Lot[]> {
    const lookbackMs = this.#lookbackDays * 24 * 60 * 60 * 1000;
    const cutoffSec = (Date.now() - lookbackMs) / 1000;

    const sigs = (await this.#rpcPool.call('getSignaturesForAddress', [
      wallet.toBase58(),
      { limit: DEFAULT_SIG_PAGE_SIZE },
    ])) as SignatureEntry[] | null;

    const lots: Lot[] = [];
    let accounted = 0n;
    let oldestSlotWalked = Number.MAX_SAFE_INTEGER;

    for (const sigInfo of sigs ?? []) {
      if (sigInfo.blockTime !== null && sigInfo.blockTime < cutoffSec) break;
      if (accounted >= currentBalance) break;

      const tx = (await this.#rpcPool.call('getTransaction', [
        sigInfo.signature,
        { maxSupportedTransactionVersion: 0, encoding: 'json' },
      ])) as RpcTransaction | null;
      if (!tx) continue;
      oldestSlotWalked = Math.min(oldestSlotWalked, sigInfo.slot);

      const lot = this.#classifyLotForTx(tx, wallet, mint, sigInfo.signature, sigInfo.slot);
      if (!lot) continue;
      if (lot.amount > 0n) {
        lots.push(lot);
        accounted += lot.amount;
      }
    }

    if (accounted < currentBalance) {
      const unaccounted = currentBalance - accounted;
      lots.push({
        amount: unaccounted,
        costBasisLamports: 0n,
        acquiredSlot: oldestSlotWalked === Number.MAX_SAFE_INTEGER ? 0 : oldestSlotWalked,
        acquiredSig: '',
        source: 'cold-start-unresolved',
        basisUnresolved: true,
        reconstructedAt: Date.now(),
      });
      const event: CostBasisIncompleteEvent = {
        wallet,
        mint,
        unaccountedAmount: unaccounted,
        oldestSlotWalked:
          oldestSlotWalked === Number.MAX_SAFE_INTEGER ? 0 : oldestSlotWalked,
      };
      this.emit('cost-basis-incomplete', event);
    }

    return lots;
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  #classifyLotForTx(
    tx: RpcTransaction,
    wallet: PublicKey,
    mint: PublicKey,
    sig: string,
    slot: number,
  ): Lot | null {
    const walletStr = wallet.toBase58();
    const mintStr = mint.toBase58();

    const pre = (tx.meta.preTokenBalances ?? []).find(
      (b) => b.owner === walletStr && b.mint === mintStr,
    );
    const post = (tx.meta.postTokenBalances ?? []).find(
      (b) => b.owner === walletStr && b.mint === mintStr,
    );
    const preAmt = pre?.uiTokenAmount?.amount ? BigInt(pre.uiTokenAmount.amount) : 0n;
    const postAmt = post?.uiTokenAmount?.amount ? BigInt(post.uiTokenAmount.amount) : 0n;
    const delta = postAmt - preAmt;
    if (delta <= 0n) return null;

    // Try registered tracers first. Tracers have richer knowledge (e.g. a
    // pump.fun decoder can pull the exact lamport outflow from log events)
    // than the SOL-outflow heuristic, so they always win when they match.
    const parsedTx = this.#toParsedTransaction(tx, sig, slot);
    for (const programId of parsedTx.programIds) {
      for (const tracer of this.#tracerRegistry.tracersFor(programId)) {
        const result = tracer.trace(parsedTx, wallet, mint);
        if (!result) continue;
        if (result.kind === 'swap') {
          return {
            amount: result.tokensIn,
            costBasisLamports: result.solOut,
            acquiredSlot: slot,
            acquiredSig: sig,
            source: 'cold-start-reconstructed',
            reconstructedAt: Date.now(),
          };
        }
        if (result.kind === 'transfer-in') {
          return {
            amount: delta,
            costBasisLamports: 0n,
            acquiredSlot: slot,
            acquiredSig: sig,
            source: 'transfer-in',
            reconstructedAt: Date.now(),
          };
        }
      }
    }

    // Fallback: SOL-outflow heuristic. If the fee payer sent SOL in this tx
    // beyond what the network fee accounts for, treat that outflow as the
    // lot's cost basis. This covers AMM swaps we don't have a decoder for.
    const accountIdx = tx.transaction.message.accountKeys.indexOf(walletStr);
    const fee = BigInt(tx.meta.fee ?? 0);
    let solOutflow = 0n;
    if (accountIdx >= 0) {
      const preBal = tx.meta.preBalances?.[accountIdx];
      const postBal = tx.meta.postBalances?.[accountIdx];
      if (preBal !== undefined && postBal !== undefined) {
        const before = BigInt(preBal);
        const after = BigInt(postBal);
        solOutflow = before - after - fee;
        if (solOutflow < 0n) solOutflow = 0n;
      }
    }

    if (solOutflow > 0n) {
      return {
        amount: delta,
        costBasisLamports: solOutflow,
        acquiredSlot: slot,
        acquiredSig: sig,
        source: 'cold-start-reconstructed',
        reconstructedAt: Date.now(),
      };
    }

    // No SOL outflow and no tracer match → airdrop / claim / reward.
    return {
      amount: delta,
      costBasisLamports: 0n,
      acquiredSlot: slot,
      acquiredSig: sig,
      source: 'airdrop',
      reconstructedAt: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // RPC → ParsedTransaction adapter
  // -------------------------------------------------------------------------

  #toParsedTransaction(tx: RpcTransaction, sig: string, slot: number): ParsedTransaction {
    const accounts = tx.transaction.message.accountKeys.map((k) => PublicKey.fromBase58(k));
    const fallbackProgram = PublicKey.fromBase58('11111111111111111111111111111111');

    const ixs = (tx.transaction.message.instructions ?? []).map((ix) => {
      const programId = accounts[ix.programIdIndex] ?? fallbackProgram;
      const ixAccounts = (ix.accounts ?? []).map((idx) => accounts[idx] ?? fallbackProgram);
      const data =
        ix.data !== undefined && ix.data !== ''
          ? new Uint8Array(Buffer.from(ix.data, 'base64'))
          : new Uint8Array();
      return { programId, accounts: ixAccounts, data };
    });

    const uniqueProgramIds = Array.from(new Set(ixs.map((i) => i.programId.toBase58()))).map(
      (b58) => PublicKey.fromBase58(b58),
    );

    return {
      signature: sig,
      slot,
      programIds: uniqueProgramIds,
      meta: {
        preBalances: new Map(),
        postBalances: new Map(),
        preTokenBalances: [],
        postTokenBalances: [],
        feeLamports: BigInt(tx.meta.fee ?? 0),
        logMessages: tx.meta.logMessages ?? [],
      },
      instructions: ixs,
    };
  }
}
