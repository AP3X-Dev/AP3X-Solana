import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PublicKey, rpcU64 } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { PortfolioReadApi } from './portfolio-read-api.js';
import type { CostBasisReconstructor } from './reconstructor.js';
import { IncompletePnlError, type Lot, type LandedTrade, type ObserveOpts, type Position, type PositionChange, type RealizedPnlEvent, type RealizedPnlStatus } from './types.js';
import { reduceLots, unrealizedPnl, type AccountingMethod } from './accounting.js';
import { fetchTokenBalances } from './token-balances.js';

export interface FilePortfolioStoreOpts {
  dir?: string;
  /** Needed by {@link FilePortfolioStore.observe} and {@link FilePortfolioStore.rebuildPosition}. */
  rpcPool?: RpcPool;
  /** Needed by {@link FilePortfolioStore.observe} and {@link FilePortfolioStore.rebuildPosition}. */
  reconstructor?: CostBasisReconstructor;
}

interface AuditEntry { ts: number; event: string; meta: Record<string, unknown>; }

interface WalletData {
  positions: Position[];
  /** Total realized PnL across all mints. */
  realizedPnl: bigint;
  /** Realized PnL per mint (base58). Files written before this existed have none. */
  realizedPnlByMint: Record<string, bigint>;
  realizedEntries: Record<string, Record<string, { slot: number; amount: bigint; proceeds: bigint | null; costBasis: bigint | null;
    resolution?: { proceeds: bigint; costBasis: bigint } }>>;
  /** Receipt aggregates recorded since this registry was introduced. */
  appliedTrades: Record<string, string>;
  /** Cost-basis method used when reducing lots (default FIFO). */
  method?: AccountingMethod;
}

const emptyWallet = (): WalletData => ({ positions: [], realizedPnl: 0n, realizedPnlByMint: {}, realizedEntries: {}, appliedTrades: {} });

export class FilePortfolioStore extends EventEmitter implements PortfolioReadApi {
  private readonly dir: string;
  private readonly rpcPool: RpcPool | undefined;
  private readonly reconstructor: CostBasisReconstructor | undefined;
  private readonly mutexes = new Map<string, Promise<void>>();

  constructor(opts: FilePortfolioStoreOpts = {}) {
    super();
    this.dir = opts.dir ?? '.ap3x/portfolio';
    this.rpcPool = opts.rpcPool;
    this.reconstructor = opts.reconstructor;
  }

  async getPosition(wallet: PublicKey, mint: PublicKey): Promise<Position | null> {
    const data = await this.loadWalletData(wallet);
    return data?.positions.find((p) => p.mint.equals(mint)) ?? null;
  }

  async getAllPositions(wallet: PublicKey): Promise<Position[]> {
    return (await this.loadWalletData(wallet))?.positions ?? [];
  }

  async getRealizedPnl(wallet: PublicKey, mint: PublicKey): Promise<bigint> {
    const status = await this.getRealizedPnlStatus(wallet, mint);
    if (!status.complete) throw new IncompletePnlError(status.unresolvedSignatures);
    return status.knownRealizedLamports;
  }

  async getRealizedPnlStatus(wallet: PublicKey, mint: PublicKey): Promise<RealizedPnlStatus> {
    const data = await this.loadWalletData(wallet);
    const unresolvedSignatures = Object.entries(data?.realizedEntries[mint.toBase58()] ?? {})
      .filter(([, entry]) => !entry.resolution).map(([signature]) => signature).sort();
    return { knownRealizedLamports: data?.realizedPnlByMint[mint.toBase58()] ?? 0n,
      complete: unresolvedSignatures.length === 0, unresolvedSignatures };
  }

  /** `currentPriceLamports` uses the {@link PRICE_SCALE} convention. */
  async getUnrealizedPnl(wallet: PublicKey, mint: PublicKey, currentPriceLamports: bigint): Promise<bigint> {
    const pos = await this.getPosition(wallet, mint);
    if (pos?.lots.some(l => l.basisUnresolved)) throw new IncompletePnlError(pos.lots.filter(l => l.basisUnresolved).map(l => l.acquiredSig).filter(Boolean));
    return pos ? unrealizedPnl(pos.lots, currentPriceLamports) : 0n;
  }

  async readAudit(wallet: PublicKey): Promise<AuditEntry[]> {
    try {
      const raw = await fs.readFile(this.auditPathFor(wallet), 'utf8');
      return raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEntry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Begin tracking a wallet: every token it holds that has no position yet is
   * cold-started from on-chain history (once — the result persists). `method`
   * sets how later sells reduce lots for this wallet.
   */
  async observe(wallet: PublicKey, opts: ObserveOpts = {}): Promise<PositionChange[]> {
    const { rpcPool, reconstructor } = this.requireChainAccess('observe');
    const balances = await fetchTokenBalances(rpcPool, wallet);
    return this.withMutex(wallet.toBase58(), async () => {
      const data = (await this.loadWalletData(wallet)) ?? emptyWallet();
      if (opts.method) data.method = opts.method;
      const changes: PositionChange[] = [];
      for (const [mintStr, balance] of balances) {
        if (balance === 0n) continue;
        const mint = PublicKey.fromBase58(mintStr);
        if (data.positions.some((p) => p.mint.equals(mint))) continue;
        const lots = await reconstructor.reconstruct(wallet, mint, balance, opts.lookbackDays);
        const after: Position = { mint, walletAddress: wallet, lots, lastUpdatedSlot: maxSlot(lots) };
        data.positions.push(after);
        changes.push({ wallet, mint, before: null, after, reason: 'cold-start' });
      }
      await this.writeWalletData(wallet, data);
      for (const c of changes) {
        await this.audit(wallet, {
          ts: Date.now(),
          event: 'cold-start',
          meta: { mint: c.mint.toBase58(), lots: c.after.lots.length },
        });
        this.emit('change', c);
      }
      return changes;
    });
  }

  /**
   * Replace a position's lots with a fresh reconstruction against
   * `observedBalance` — used by the reconciler when on-chain balance drifts
   * from the store.
   */
  async rebuildPosition(wallet: PublicKey, mint: PublicKey, observedBalance: bigint): Promise<PositionChange> {
    const { reconstructor } = this.requireChainAccess('rebuildPosition');
    const lots = await reconstructor.reconstruct(wallet, mint, observedBalance);
    return this.withMutex(wallet.toBase58(), async () => {
      const data = (await this.loadWalletData(wallet)) ?? emptyWallet();
      const idx = data.positions.findIndex((p) => p.mint.equals(mint));
      const before = idx >= 0 ? clonePosition(data.positions[idx]!) : null;
      const after: Position = { mint, walletAddress: wallet, lots, lastUpdatedSlot: maxSlot(lots) };
      if (idx >= 0) data.positions[idx] = after;
      else data.positions.push(after);
      await this.writeWalletData(wallet, data);
      await this.audit(wallet, {
        ts: Date.now(),
        event: 'reconcile',
        meta: { mint: mint.toBase58(), observedBalance: observedBalance.toString() },
      });
      const change: PositionChange = { wallet, mint, before, after, reason: 'reconcile' };
      this.emit('change', change);
      return change;
    });
  }

  /** Manually set one lot's cost basis (e.g. after resolving an unknown basis). */
  async correctLotBasis(
    wallet: PublicKey,
    mint: PublicKey,
    lotIndex: number,
    costBasisLamports: bigint,
  ): Promise<{ oldBasis: bigint }> {
    if (!Number.isSafeInteger(lotIndex) || lotIndex < 0) throw new Error('lot index must be a nonnegative safe integer');
    if (typeof costBasisLamports !== 'bigint' || costBasisLamports < 0n) throw new Error('cost basis must be a nonnegative bigint');
    return this.withMutex(wallet.toBase58(), async () => {
      const data = await this.loadWalletData(wallet);
      const pos = data?.positions.find((p) => p.mint.equals(mint));
      if (!data || !pos) throw new Error('no position');
      const lot = pos.lots[lotIndex];
      if (!lot) throw new Error('lot index out of range');
      const before = clonePosition(pos);
      pos.lots[lotIndex] = { ...lot, costBasisLamports, basisUnresolved: false };
      await this.writeWalletData(wallet, data);
      await this.audit(wallet, {
        ts: Date.now(),
        event: 'manual-correction',
        meta: {
          mint: mint.toBase58(),
          lotIndex,
          oldBasis: lot.costBasisLamports.toString(),
          newBasis: costBasisLamports.toString(),
        },
      });
      this.emit('change', { wallet, mint, before, after: pos, reason: 'manual-correction' } satisfies PositionChange);
      return { oldBasis: lot.costBasisLamports };
    });
  }

  async _upsertForTest(pos: Position): Promise<void> {
    await this.withMutex(pos.walletAddress.toBase58(), async () => {
      const data = (await this.loadWalletData(pos.walletAddress)) ?? emptyWallet();
      const idx = data.positions.findIndex((p) => p.mint.equals(pos.mint));
      if (idx >= 0) {
        data.positions[idx] = pos;
      } else {
        data.positions.push(pos);
      }
      await this.writeWalletData(pos.walletAddress, data);
    });
  }

  async _auditForTest(wallet: PublicKey, entry: AuditEntry): Promise<void> {
    await this.audit(wallet, entry);
  }

  async applyLandedTrade(trade: LandedTrade): Promise<PositionChange[]> {
    if (typeof trade.signature !== 'string' || !trade.signature || !Number.isSafeInteger(trade.slot) || trade.slot < 0 || typeof trade.amountDelta !== 'bigint'
      || trade.solFlowLamports !== null && typeof trade.solFlowLamports !== 'bigint'
      || typeof trade.feeLamports !== 'bigint' || trade.feeLamports < 0n
      || trade.transactionNetSolFlowLamports !== undefined && typeof trade.transactionNetSolFlowLamports !== 'bigint')
      throw new Error('Invalid landed trade quantities or identity');
    const magnitude = (v: bigint) => v < 0n ? -v : v;
    rpcU64(magnitude(trade.amountDelta), 'Token quantity');
    rpcU64(trade.feeLamports, 'Network fee');
    if (trade.solFlowLamports !== null) rpcU64(magnitude(trade.solFlowLamports), 'Settlement cash flow');
    if (trade.transactionNetSolFlowLamports !== undefined) rpcU64(magnitude(trade.transactionNetSolFlowLamports), 'Transaction net cash flow');
    return this.withMutex(trade.wallet.toBase58(), async () => {
      const data = (await this.loadWalletData(trade.wallet)) ?? emptyWallet();
      const tradeKey = JSON.stringify([trade.signature, trade.mint.toBase58()]);
      const fingerprint = JSON.stringify([trade.slot, trade.amountDelta, trade.solFlowLamports, trade.feeLamports,
        trade.transactionNetSolFlowLamports ?? null], this.bigintReplacer);
      if (data.appliedTrades[tradeKey] !== undefined) {
        if (data.appliedTrades[tradeKey] !== fingerprint) throw new Error('Conflicting landed receipt aggregate');
        return [];
      }
      const idx = data.positions.findIndex((p) => p.mint.equals(trade.mint));

      const existingPos = idx >= 0 ? data.positions[idx]! : null;
      const before: Position | null = existingPos ? clonePosition(existingPos) : null;

      let pos: Position = existingPos ?? {
        mint: trade.mint,
        walletAddress: trade.wallet,
        lots: [],
        lastUpdatedSlot: 0,
      };

      let realizedEvent: RealizedPnlEvent | null = null;
      if (trade.amountDelta > 0n) {
        const lot = {
          amount: trade.amountDelta,
          costBasisLamports: trade.solFlowLamports !== null && trade.solFlowLamports < 0n ? -trade.solFlowLamports : 0n,
          acquiredSlot: trade.slot,
          acquiredSig: trade.signature,
          source: 'trade' as const,
          ...(trade.solFlowLamports === null ? { basisUnresolved: true } : {}),
        };
        pos = { ...pos, lots: [...pos.lots, lot], lastUpdatedSlot: trade.slot };
      } else if (trade.amountDelta < 0n) {
        const proceeds = trade.solFlowLamports === null ? null : trade.solFlowLamports > 0n ? trade.solFlowLamports : 0n;
        const r = reduceLots(pos.lots, -trade.amountDelta, proceeds ?? 0n, data.method ?? 'fifo');
        const mintKey = trade.mint.toBase58();
        const complete = proceeds !== null && !r.basisUnresolved;
        if (complete) {
          data.realizedPnl += r.realized;
          data.realizedPnlByMint[mintKey] = (data.realizedPnlByMint[mintKey] ?? 0n) + r.realized;
        } else {
          const entries = data.realizedEntries[mintKey] ??= {};
          Object.defineProperty(entries, trade.signature, { enumerable: true, configurable: true, writable: true,
            value: { slot: trade.slot, amount: -trade.amountDelta, proceeds, costBasis: r.basisUnresolved ? null : r.costBasis } });
        }
        pos = { ...pos, lots: r.remaining, lastUpdatedSlot: trade.slot };
        realizedEvent = {
          wallet: trade.wallet,
          mint: trade.mint,
          realized: complete ? r.realized : null,
          costBasis: r.basisUnresolved ? null : r.costBasis,
          proceeds,
          basisUnresolved: r.basisUnresolved,
          slot: trade.slot,
        };
      }

      if (idx >= 0) {
        data.positions[idx] = pos;
      } else {
        data.positions.push(pos);
      }

      data.appliedTrades[tradeKey] = fingerprint;
      await this.writeWalletData(trade.wallet, data);
      await this.audit(trade.wallet, {
        ts: Date.now(),
        event: 'apply-landed-trade',
        meta: {
          sig: trade.signature,
          slot: trade.slot,
          mint: trade.mint.toBase58(),
          amountDelta: trade.amountDelta.toString(),
          cashFlowUnresolved: trade.solFlowLamports === null,
        },
      });
      if (realizedEvent) this.emit('realized-pnl', realizedEvent);

      const change: PositionChange = {
        wallet: trade.wallet,
        mint: trade.mint,
        before,
        after: pos,
        reason: 'apply-landed-trade',
      };
      this.emit('change', change);
      return [change];
    });
  }

  /** Record an explicitly established sale settlement; repeats are idempotent and known facts cannot be replaced. */
  async resolveRealizedPnl(wallet: PublicKey, mint: PublicKey, signature: string, proceeds: bigint, costBasis: bigint): Promise<void> {
    if (typeof proceeds !== 'bigint' || proceeds < 0n || typeof costBasis !== 'bigint' || costBasis < 0n)
      throw new Error('Settlement proceeds and cost basis must be nonnegative bigint');
    await this.withMutex(wallet.toBase58(), async () => {
      const data = await this.loadWalletData(wallet);
      const entries = data?.realizedEntries[mint.toBase58()];
      const entry = entries && Object.hasOwn(entries, signature) ? entries[signature] : undefined;
      if (!data || !entry) throw new Error('No unresolved realized settlement for this signature/mint');
      if (entry.resolution) {
        if (entry.resolution.proceeds !== proceeds || entry.resolution.costBasis !== costBasis) throw new Error('Conflicting settlement resolution');
        return;
      }
      if (entry.proceeds !== null && entry.proceeds !== proceeds || entry.costBasis !== null && entry.costBasis !== costBasis)
        throw new Error('Settlement resolution conflicts with known receipt facts');
      entry.resolution = { proceeds, costBasis };
      const realized = proceeds - costBasis;
      data.realizedPnl += realized;
      data.realizedPnlByMint[mint.toBase58()] = (data.realizedPnlByMint[mint.toBase58()] ?? 0n) + realized;
      await this.writeWalletData(wallet, data);
      await this.audit(wallet, { ts: Date.now(), event: 'resolve-realized-pnl', meta: { signature, mint: mint.toBase58(),
        proceeds: String(proceeds), costBasis: String(costBasis) } });
      this.emit('realized-pnl', { wallet, mint, realized, proceeds, costBasis, basisUnresolved: false, slot: entry.slot });
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private requireChainAccess(op: string): { rpcPool: RpcPool; reconstructor: CostBasisReconstructor } {
    if (!this.rpcPool || !this.reconstructor) {
      throw new Error(`FilePortfolioStore.${op} needs the rpcPool and reconstructor options`);
    }
    return { rpcPool: this.rpcPool, reconstructor: this.reconstructor };
  }

  private async audit(wallet: PublicKey, entry: AuditEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.auditPathFor(wallet), JSON.stringify(entry) + '\n');
  }

  private async loadWalletData(wallet: PublicKey): Promise<WalletData | null> {
    try {
      const raw = await fs.readFile(this.pathFor(wallet), 'utf8');
      const parsed = JSON.parse(raw, this.bigintReviver) as {
        positions: Array<Omit<Position, 'mint' | 'walletAddress'> & { mint: string; walletAddress: string }>;
        realizedPnl: bigint;
        realizedPnlByMint?: Record<string, bigint>;
        realizedEntries?: WalletData['realizedEntries'];
        appliedTrades?: Record<string, string>;
        method?: AccountingMethod;
      };
      const positions: Position[] = parsed.positions.map((p) => ({
        ...p,
        mint: PublicKey.fromBase58(p.mint),
        walletAddress: PublicKey.fromBase58(p.walletAddress),
        lots: p.lots.map(l => ({ ...l, amount: persistedBigint(l.amount), costBasisLamports: persistedBigint(l.costBasisLamports) })),
      }));
      return {
        positions,
        realizedPnl: persistedBigint(parsed.realizedPnl),
        realizedPnlByMint: Object.fromEntries(Object.entries(parsed.realizedPnlByMint ?? {}).map(([mint, amount]) => [mint, persistedBigint(amount)])),
        realizedEntries: Object.fromEntries(Object.entries(parsed.realizedEntries ?? {}).map(([mint, entries]) => [mint,
          Object.fromEntries(Object.entries(entries).map(([signature, entry]) => [signature, { ...entry,
            amount: persistedBigint(entry.amount), costBasis: entry.costBasis === null ? null : persistedBigint(entry.costBasis),
            proceeds: entry.proceeds === null ? null : persistedBigint(entry.proceeds),
            ...(entry.resolution ? { resolution: { proceeds: persistedBigint(entry.resolution.proceeds), costBasis: persistedBigint(entry.resolution.costBasis) } } : {}),
          }]))])),
        appliedTrades: parsed.appliedTrades ?? {},
        ...(parsed.method ? { method: parsed.method } : {}),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async writeWalletData(wallet: PublicKey, data: WalletData): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const p = this.pathFor(wallet);
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    const payload = {
      positions: data.positions.map((pos) => ({
        ...pos,
        mint: pos.mint.toBase58(),
        walletAddress: pos.walletAddress.toBase58(),
      })),
      realizedPnl: data.realizedPnl,
      realizedPnlByMint: data.realizedPnlByMint,
      realizedEntries: data.realizedEntries,
      appliedTrades: data.appliedTrades,
      ...(data.method ? { method: data.method } : {}),
    };
    const serialised = JSON.stringify(payload, this.bigintReplacer);
    await fs.writeFile(tmp, serialised, { encoding: 'utf8' });
    await fs.rename(tmp, p);
  }

  private readonly bigintReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') return { $ap3xBigInt: String(value) };
    return value;
  };

  private readonly bigintReviver = (_key: string, value: unknown): unknown => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && '$ap3xBigInt' in value
      && typeof value.$ap3xBigInt === 'string' && /^-?\d+$/.test(value.$ap3xBigInt)) {
      return BigInt(value.$ap3xBigInt);
    }
    return value;
  };

  private pathFor(wallet: PublicKey): string {
    return path.join(this.dir, `${wallet.toBase58()}.json`);
  }

  private auditPathFor(wallet: PublicKey): string {
    return path.join(this.dir, `${wallet.toBase58()}.audit.jsonl`);
  }

  private async withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(key) ?? Promise.resolve();
    let resolveOuter!: () => void;
    const next = new Promise<void>((res) => { resolveOuter = res; });
    // Chain: current task waits for prev, then signals next via resolveOuter
    this.mutexes.set(key, prev.then(() => next).catch(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      resolveOuter();
    }
  }
}

function clonePosition(p: Position): Position {
  // Manual clone: structuredClone fails on PublicKey private fields.
  return { mint: p.mint, walletAddress: p.walletAddress, lastUpdatedSlot: p.lastUpdatedSlot, lots: p.lots.map((l) => ({ ...l })) };
}

/** Legacy numeric suffixes are interpreted only in numeric fields, never identifiers. */
function persistedBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  throw new Error('Invalid persisted bigint quantity');
}

function maxSlot(lots: Lot[]): number {
  return lots.reduce((m, l) => Math.max(m, l.acquiredSlot), 0);
}
