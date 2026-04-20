import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@ap3x/solana-core';
import type { PortfolioReadApi } from './portfolio-read-api.js';
import type { Position, LotSource, LandedTrade, PositionChange } from './types.js';
import { reduceLots } from './accounting.js';

export interface FilePortfolioStoreOpts {
  dir?: string;
}

interface AuditEntry { ts: number; event: string; meta: Record<string, unknown>; }

/** Serialised position — public keys stored as base58 strings. */
interface PositionRaw {
  mint: string;
  walletAddress: string;
  lastUpdatedSlot: number;
  lots: {
    amount: bigint;
    costBasisLamports: bigint;
    acquiredSlot: number;
    acquiredSig: string;
    source: LotSource;
    reconstructedAt?: number;
    basisUnresolved?: boolean;
  }[];
}

interface WalletData {
  positions: Position[];
  realizedPnl: bigint;
}

/**
 * `FilePortfolioStore` — file-backed portfolio store.
 *
 * Layout:
 *   `<dir>/<wallet>.json`         — positions + realizedPnl for the wallet
 *   `<dir>/<wallet>.audit.jsonl`  — append-only audit log (one JSON object per line)
 *
 * Durability:
 *   Writes go to a `.tmp.<pid>.<ts>` file first, then atomically renamed into
 *   place. On POSIX this is a true atomic rename; on Windows it avoids the
 *   half-written-JSON failure mode.
 *
 * Concurrency:
 *   Per-wallet promise-chain mutex serialises concurrent writes for the same
 *   wallet so the tmp+rename sequence never interleaves.
 *
 * BigInt serialisation:
 *   BigInt values are encoded as `"<digits>n"` strings (e.g. `"1000n"`) via a
 *   JSON replacer, and decoded via a matching reviver, so u64-max survives a
 *   round-trip through JSON without precision loss.
 */
export class FilePortfolioStore extends EventEmitter implements PortfolioReadApi {
  private readonly dir: string;
  private readonly mutexes = new Map<string, Promise<void>>();

  constructor(opts: FilePortfolioStoreOpts = {}) {
    super();
    this.dir = opts.dir ?? '.ap3x/portfolio';
  }

  async getPosition(wallet: PublicKey, mint: PublicKey): Promise<Position | null> {
    const data = await this.loadWalletData(wallet);
    return data?.positions.find((p) => p.mint.equals(mint)) ?? null;
  }

  async getAllPositions(wallet: PublicKey): Promise<Position[]> {
    return (await this.loadWalletData(wallet))?.positions ?? [];
  }

  async getRealizedPnl(wallet: PublicKey, _mint: PublicKey): Promise<bigint> {
    const data = await this.loadWalletData(wallet);
    return data?.realizedPnl ?? 0n;
  }

  async getUnrealizedPnl(_wallet: PublicKey, _mint: PublicKey, _currentPriceLamports: bigint): Promise<bigint> {
    return 0n;
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

  /** Test-only: insert or replace a position directly without going through applyLandedTrade. */
  async _upsertForTest(pos: Position): Promise<void> {
    await this.withMutex(pos.walletAddress.toBase58(), async () => {
      const data = (await this.loadWalletData(pos.walletAddress)) ?? { positions: [], realizedPnl: 0n };
      const idx = data.positions.findIndex((p) => p.mint.equals(pos.mint));
      if (idx >= 0) {
        data.positions[idx] = pos;
      } else {
        data.positions.push(pos);
      }
      await this.writeWalletData(pos.walletAddress, data);
    });
  }

  /** Test-only: append a raw audit entry. */
  async _auditForTest(wallet: PublicKey, entry: AuditEntry): Promise<void> {
    await this.audit(wallet, entry);
  }

  async applyLandedTrade(trade: LandedTrade): Promise<PositionChange[]> {
    return this.withMutex(trade.wallet.toBase58(), async () => {
      const data = (await this.loadWalletData(trade.wallet)) ?? { positions: [], realizedPnl: 0n };
      const idx = data.positions.findIndex((p) => p.mint.equals(trade.mint));

      // Manually clone `before` to avoid structuredClone failing on PublicKey private fields.
      const existingPos = idx >= 0 ? data.positions[idx]! : null;
      const before: Position | null = existingPos
        ? {
            mint: existingPos.mint,
            walletAddress: existingPos.walletAddress,
            lastUpdatedSlot: existingPos.lastUpdatedSlot,
            lots: existingPos.lots.map((l) => ({ ...l })),
          }
        : null;

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
        const r = reduceLots(pos.lots, -trade.amountDelta, proceeds, 'fifo');
        data.realizedPnl += r.realized;
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

  private async audit(wallet: PublicKey, entry: AuditEntry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.auditPathFor(wallet), JSON.stringify(entry) + '\n');
  }

  private async loadWalletData(wallet: PublicKey): Promise<WalletData | null> {
    try {
      const raw = await fs.readFile(this.pathFor(wallet), 'utf8');
      const parsed = JSON.parse(raw, this.bigintReviver) as {
        positions: PositionRaw[];
        realizedPnl: bigint;
      };
      const positions: Position[] = parsed.positions.map((p) => ({
        ...p,
        mint: PublicKey.fromBase58(p.mint),
        walletAddress: PublicKey.fromBase58(p.walletAddress),
      }));
      return { positions, realizedPnl: parsed.realizedPnl };
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
    if (typeof value === 'string' && /^\d+n$/.test(value)) {
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
