import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { PortfolioReadApi } from './portfolio-read-api.js';
import type { CostBasisReconstructor } from './reconstructor.js';
import type { Lot, LandedTrade, ObserveOpts, Position, PositionChange } from './types.js';
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
  /** Cost-basis method used when reducing lots (default FIFO). */
  method?: AccountingMethod;
}

const emptyWallet = (): WalletData => ({ positions: [], realizedPnl: 0n, realizedPnlByMint: {} });

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
    const data = await this.loadWalletData(wallet);
    return data?.realizedPnlByMint[mint.toBase58()] ?? 0n;
  }

  /** `currentPriceLamports` uses the {@link PRICE_SCALE} convention. */
  async getUnrealizedPnl(wallet: PublicKey, mint: PublicKey, currentPriceLamports: bigint): Promise<bigint> {
    const pos = await this.getPosition(wallet, mint);
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
    return this.withMutex(trade.wallet.toBase58(), async () => {
      const data = (await this.loadWalletData(trade.wallet)) ?? emptyWallet();
      const idx = data.positions.findIndex((p) => p.mint.equals(trade.mint));

      const existingPos = idx >= 0 ? data.positions[idx]! : null;
      const before: Position | null = existingPos ? clonePosition(existingPos) : null;

      let pos: Position = existingPos ?? {
        mint: trade.mint,
        walletAddress: trade.wallet,
        lots: [],
        lastUpdatedSlot: 0,
      };

      if (trade.amountDelta > 0n) {
        const lot = {
          amount: trade.amountDelta,
          costBasisLamports: trade.solFlowLamports < 0n ? -trade.solFlowLamports : 0n,
          acquiredSlot: trade.slot,
          acquiredSig: trade.signature,
          source: 'trade' as const,
        };
        pos = { ...pos, lots: [...pos.lots, lot], lastUpdatedSlot: trade.slot };
      } else if (trade.amountDelta < 0n) {
        const proceeds = trade.solFlowLamports > 0n ? trade.solFlowLamports : 0n;
        const r = reduceLots(pos.lots, -trade.amountDelta, proceeds, data.method ?? 'fifo');
        const mintKey = trade.mint.toBase58();
        data.realizedPnl += r.realized;
        data.realizedPnlByMint[mintKey] = (data.realizedPnlByMint[mintKey] ?? 0n) + r.realized;
        pos = { ...pos, lots: r.remaining, lastUpdatedSlot: trade.slot };
        this.emit('realized-pnl', {
          wallet: trade.wallet,
          mint: trade.mint,
          realized: r.realized,
          costBasis: r.costBasis,
          proceeds: r.proceeds,
          basisUnresolved: r.basisUnresolved,
          slot: trade.slot,
        });
      }

      if (idx >= 0) {
        data.positions[idx] = pos;
      } else {
        data.positions.push(pos);
      }

      await this.writeWalletData(trade.wallet, data);
      await this.audit(trade.wallet, {
        ts: Date.now(),
        event: 'apply-landed-trade',
        meta: {
          sig: trade.signature,
          slot: trade.slot,
          mint: trade.mint.toBase58(),
          amountDelta: trade.amountDelta.toString(),
        },
      });

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
        method?: AccountingMethod;
      };
      const positions: Position[] = parsed.positions.map((p) => ({
        ...p,
        mint: PublicKey.fromBase58(p.mint),
        walletAddress: PublicKey.fromBase58(p.walletAddress),
      }));
      return {
        positions,
        realizedPnl: parsed.realizedPnl,
        realizedPnlByMint: parsed.realizedPnlByMint ?? {},
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
      ...(data.method ? { method: data.method } : {}),
    };
    const serialised = JSON.stringify(payload, this.bigintReplacer);
    await fs.writeFile(tmp, serialised, { encoding: 'utf8' });
    await fs.rename(tmp, p);
  }

  private readonly bigintReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') return `${value}n`;
    return value;
  };

  private readonly bigintReviver = (_key: string, value: unknown): unknown => {
    if (typeof value === 'string' && /^-?\d+n$/.test(value)) {
      return BigInt(value.slice(0, -1));
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

function maxSlot(lots: Lot[]): number {
  return lots.reduce((m, l) => Math.max(m, l.acquiredSlot), 0);
}
