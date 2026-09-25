/**
 * CostBasisReconstructor — cold-start cost-basis reconstruction.
 *
 *   1. Walk the wallet's signatures newest-first (paginated) and keep every
 *      transaction that changed its balance of `mint`. Stop at the one that
 *      opened the current position (balance went 0 → >0), at the lookback
 *      cutoff, or when history runs out.
 *   2. Whatever was held before the oldest walked transaction becomes one
 *      `cold-start-unresolved` lot (history beyond the walk is unknown).
 *   3. Replay oldest → newest: inflows add lots (registered swap tracers first,
 *      then the SOL-outflow heuristic; transfer-ins ask the optional
 *      `transferBasis` hook), outflows consume lots FIFO — so a buy, sell, buy
 *      sequence leaves the right lots behind.
 *   4. Reconcile with `currentBalance` (trim FIFO, or add an unresolved lot)
 *      and emit `cost-basis-incomplete` whenever any basis is unresolved.
 *
 * RPC shapes are narrow local interfaces; numeric fields accept numbers (real
 * RPC) or bigints (fixtures). Transactions are fetched as `json` with
 * `maxSupportedTransactionVersion: 1`, so instruction data is base58 and
 * address-lookup-table accounts come from `meta.loadedAddresses`.
 */

import { EventEmitter } from 'node:events';

import { base58, PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';

import { reduceLots } from './accounting.js';
import type { ParsedTransaction, SwapTracerRegistry } from './swap-tracer.js';
import type { CostBasisIncompleteEvent, Lot } from './types.js';

interface SignatureEntry {
  signature: string;
  slot: number;
  blockTime: number | null;
  err?: unknown;
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

interface RpcTransaction {
  slot: number;
  meta: {
    err?: unknown;
    preBalances?: Array<number | bigint>;
    postBalances?: Array<number | bigint>;
    fee?: number | bigint;
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
    logMessages?: string[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  };
  transaction: {
    message: { accountKeys: string[]; instructions?: RpcInstruction[] };
    signatures?: string[];
  };
}

/**
 * Cost basis for tokens that arrived by transfer. Return the basis in
 * lamports when the source is a tracked wallet (e.g. another vault wallet),
 * or `undefined` to leave the lot's basis unresolved.
 */
export type TransferBasisResolver = (transfer: {
  source: PublicKey | undefined;
  mint: PublicKey;
  amount: bigint;
  slot: number;
  signature: string;
}) => Promise<bigint | undefined> | bigint | undefined;

export interface CostBasisReconstructorOpts {
  rpcPool: RpcPool;
  tracerRegistry: SwapTracerRegistry;
  lookbackDays?: number;
  transferBasis?: TransferBasisResolver;
}

export interface CostBasisReconstructorEvents {
  'cost-basis-incomplete': (event: CostBasisIncompleteEvent) => void;
}

const DEFAULT_LOOKBACK_DAYS = 90;
const SIG_PAGE_SIZE = 1000;

interface BalanceChange {
  signature: string;
  slot: number;
  tx: RpcTransaction;
  pre: bigint;
  post: bigint;
}

export class CostBasisReconstructor extends EventEmitter {
  readonly #rpcPool: RpcPool;
  readonly #tracerRegistry: SwapTracerRegistry;
  readonly #lookbackDays: number;
  readonly #transferBasis: TransferBasisResolver | undefined;

  constructor(opts: CostBasisReconstructorOpts) {
    super();
    this.#rpcPool = opts.rpcPool;
    this.#tracerRegistry = opts.tracerRegistry;
    this.#lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    this.#transferBasis = opts.transferBasis;
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

  /** `lookbackDays` overrides the constructor's lookback for this call. */
  async reconstruct(wallet: PublicKey, mint: PublicKey, currentBalance: bigint, lookbackDays?: number): Promise<Lot[]> {
    const { changes, oldestSlotWalked } = await this.#walk(wallet, mint, lookbackDays ?? this.#lookbackDays);
    const now = Date.now();
    const unresolved = (amount: bigint, slot: number): Lot => ({
      amount,
      costBasisLamports: 0n,
      acquiredSlot: slot,
      acquiredSig: '',
      source: 'cold-start-unresolved',
      basisUnresolved: true,
      reconstructedAt: now,
    });

    // Replay oldest → newest, starting from whatever was held before the walk.
    const ordered = [...changes].reverse();
    const opening = ordered[0]?.pre ?? 0n;
    let lots: Lot[] = opening > 0n ? [unresolved(opening, oldestSlotWalked)] : [];
    for (const c of ordered) {
      const delta = c.post - c.pre;
      if (delta > 0n) {
        lots.push(await this.#classifyInflow(c, wallet, mint, delta, now));
      } else {
        const held = lots.reduce((s, l) => s + l.amount, 0n);
        const out = -delta < held ? -delta : held;
        lots = reduceLots(lots, out, 0n, 'fifo').remaining;
      }
    }

    // Reconcile with the live balance.
    const total = lots.reduce((s, l) => s + l.amount, 0n);
    if (total > currentBalance) {
      lots = reduceLots(lots, total - currentBalance, 0n, 'fifo').remaining;
    } else if (total < currentBalance) {
      lots.push(unresolved(currentBalance - total, oldestSlotWalked));
    }

    const unaccountedAmount = lots.filter((l) => l.basisUnresolved).reduce((s, l) => s + l.amount, 0n);
    if (unaccountedAmount > 0n) {
      const event: CostBasisIncompleteEvent = { wallet, mint, unaccountedAmount, oldestSlotWalked };
      this.emit('cost-basis-incomplete', event);
    }
    return lots;
  }

  // -------------------------------------------------------------------------
  // History walk
  // -------------------------------------------------------------------------

  async #walk(
    wallet: PublicKey,
    mint: PublicKey,
    lookbackDays: number,
  ): Promise<{ changes: BalanceChange[]; oldestSlotWalked: number }> {
    const cutoffSec = (Date.now() - lookbackDays * 24 * 60 * 60 * 1000) / 1000;
    const changes: BalanceChange[] = [];
    const seen = new Set<string>();
    let oldestSlotWalked = 0;
    let before: string | undefined;

    for (;;) {
      const page = ((await this.#rpcPool.call('getSignaturesForAddress', [
        wallet.toBase58(),
        { limit: SIG_PAGE_SIZE, ...(before ? { before } : {}) },
      ])) ?? []) as SignatureEntry[];
      const fresh = page.filter((s) => !seen.has(s.signature));
      if (fresh.length === 0) break;

      for (const sigInfo of fresh) {
        seen.add(sigInfo.signature);
        if (sigInfo.blockTime !== null && sigInfo.blockTime < cutoffSec) {
          return { changes, oldestSlotWalked };
        }
        if (sigInfo.err) continue;
        const tx = (await this.#rpcPool.call('getTransaction', [
          sigInfo.signature,
          { maxSupportedTransactionVersion: 1, encoding: 'json' },
        ])) as RpcTransaction | null;
        if (!tx || tx.meta?.err) continue;
        oldestSlotWalked = sigInfo.slot;

        const pre = ownedAmount(tx.meta.preTokenBalances, wallet, mint);
        const post = ownedAmount(tx.meta.postTokenBalances, wallet, mint);
        if (pre === post) continue;
        changes.push({ signature: sigInfo.signature, slot: sigInfo.slot, tx, pre, post });
        // The transaction that opened the current position: nothing before it
        // affects today's lots.
        if (pre === 0n) return { changes, oldestSlotWalked };
      }

      if (page.length < SIG_PAGE_SIZE) break;
      before = page[page.length - 1]!.signature;
    }
    return { changes, oldestSlotWalked };
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  async #classifyInflow(c: BalanceChange, wallet: PublicKey, mint: PublicKey, delta: bigint, now: number): Promise<Lot> {
    const base = { amount: delta, acquiredSlot: c.slot, acquiredSig: c.signature, reconstructedAt: now };

    // Registered tracers know more (e.g. exact lamports from a program's
    // events) than the SOL-outflow heuristic, so they win when they match.
    const parsedTx = toParsedTransaction(c.tx, c.signature, c.slot);
    for (const programId of parsedTx.programIds) {
      for (const tracer of this.#tracerRegistry.tracersFor(programId)) {
        const result = tracer.trace(parsedTx, wallet, mint);
        if (!result) continue;
        if (result.kind === 'swap') {
          return { ...base, amount: result.tokensIn, costBasisLamports: result.solOut, source: 'cold-start-reconstructed' };
        }
        return this.#transferIn(base, result.sourceWallet ?? transferSource(c.tx, wallet, mint), mint);
      }
    }

    // Fallback: SOL the wallet spent beyond the network fee is the cost.
    const keys = accountKeys(c.tx);
    const idx = keys.indexOf(wallet.toBase58());
    const preBal = c.tx.meta.preBalances?.[idx];
    const postBal = c.tx.meta.postBalances?.[idx];
    const solOut =
      idx >= 0 && preBal !== undefined && postBal !== undefined
        ? BigInt(preBal) - BigInt(postBal) - (idx === 0 ? BigInt(c.tx.meta.fee ?? 0) : 0n)
        : 0n;
    if (solOut > 0n) return { ...base, costBasisLamports: solOut, source: 'cold-start-reconstructed' };

    // Tokens arrived from another holder with no SOL leaving: a transfer.
    const source = transferSource(c.tx, wallet, mint);
    if (source) return this.#transferIn(base, source, mint);

    // No SOL out and no sender: airdrop / claim / reward.
    return { ...base, costBasisLamports: 0n, source: 'airdrop' };
  }

  async #transferIn(
    base: { amount: bigint; acquiredSlot: number; acquiredSig: string; reconstructedAt: number },
    source: PublicKey | undefined,
    mint: PublicKey,
  ): Promise<Lot> {
    const basis = await this.#transferBasis?.({
      source,
      mint,
      amount: base.amount,
      slot: base.acquiredSlot,
      signature: base.acquiredSig,
    });
    return basis === undefined
      ? { ...base, costBasisLamports: 0n, source: 'transfer-in', basisUnresolved: true }
      : { ...base, costBasisLamports: basis, source: 'transfer-in' };
  }
}

// ---------------------------------------------------------------------------
// RPC transaction helpers
// ---------------------------------------------------------------------------

/** Static keys followed by address-lookup-table keys (writable, then readonly). */
function accountKeys(tx: RpcTransaction): string[] {
  const loaded = tx.meta.loadedAddresses;
  return [...tx.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/** Sum of `owner`'s balances of `mint` across all its token accounts. */
function ownedAmount(entries: TokenBalanceEntry[] | undefined, owner: PublicKey, mint: PublicKey): bigint {
  const o = owner.toBase58();
  const m = mint.toBase58();
  return (entries ?? [])
    .filter((b) => b.owner === o && b.mint === m)
    .reduce((s, b) => s + BigInt(b.uiTokenAmount?.amount ?? '0'), 0n);
}

/** The other owner whose balance of `mint` fell the most in this transaction. */
function transferSource(tx: RpcTransaction, wallet: PublicKey, mint: PublicKey): PublicKey | undefined {
  const m = mint.toBase58();
  const owners = new Set(
    [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
      .filter((b) => b.mint === m && b.owner && b.owner !== wallet.toBase58())
      .map((b) => b.owner!),
  );
  let best: { owner: string; drop: bigint } | undefined;
  for (const owner of owners) {
    const pk = PublicKey.fromBase58(owner);
    const drop = ownedAmount(tx.meta.preTokenBalances, pk, mint) - ownedAmount(tx.meta.postTokenBalances, pk, mint);
    if (drop > 0n && (!best || drop > best.drop)) best = { owner, drop };
  }
  return best ? PublicKey.fromBase58(best.owner) : undefined;
}

function toParsedTransaction(tx: RpcTransaction, sig: string, slot: number): ParsedTransaction {
  const keys = accountKeys(tx);
  const accounts = keys.map((k) => PublicKey.fromBase58(k));
  const ixs = (tx.transaction.message.instructions ?? []).flatMap((ix) => {
    const programId = accounts[ix.programIdIndex];
    if (!programId) return [];
    const ixAccounts = (ix.accounts ?? []).flatMap((i) => (accounts[i] ? [accounts[i]!] : []));
    return [{ programId, accounts: ixAccounts, data: ix.data ? base58.decode(ix.data) : new Uint8Array() }];
  });
  const programIds = [...new Set(ixs.map((i) => i.programId.toBase58()))].map((b) => PublicKey.fromBase58(b));

  const lamports = (arr: Array<number | bigint> | undefined) =>
    new Map((arr ?? []).map((v, i) => [keys[i] ?? String(i), BigInt(v)] as const));
  const tokens = (arr: TokenBalanceEntry[] | undefined) =>
    (arr ?? []).flatMap((b) =>
      b.owner && b.mint
        ? [{ owner: PublicKey.fromBase58(b.owner), mint: PublicKey.fromBase58(b.mint), amount: BigInt(b.uiTokenAmount?.amount ?? '0') }]
        : [],
    );

  return {
    signature: sig,
    slot,
    programIds,
    meta: {
      preBalances: lamports(tx.meta.preBalances),
      postBalances: lamports(tx.meta.postBalances),
      preTokenBalances: tokens(tx.meta.preTokenBalances),
      postTokenBalances: tokens(tx.meta.postTokenBalances),
      feeLamports: BigInt(tx.meta.fee ?? 0),
      logMessages: tx.meta.logMessages ?? [],
    },
    instructions: ixs,
  };
}
