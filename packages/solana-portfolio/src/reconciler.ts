/**
 * Reconciler — periodic drift detection between the local portfolio store and
 * on-chain token balances.
 *
 * Algorithm (per wallet, per `runOnce` tick):
 *
 *   1. Load all positions from the store for the wallet.
 *   2. Fetch the wallet's token accounts from the RPC pool via
 *      `getTokenAccountsByOwner` with `jsonParsed` encoding.
 *   3. Sum amounts per mint from on-chain data.
 *   4. Compare against the sum of lot amounts in each stored position.
 *   5. If they differ, call `onDrift` with a `DriftEvent` describing the gap.
 *
 * Design notes:
 *
 *   - RPC response shapes are narrow local interfaces rather than `any`. The
 *     pool returns `unknown`; we cast after the call. This mirrors the pattern
 *     established in `reconstructor.ts`.
 *   - The `PortfolioStoreMinimal` interface captures only what `Reconciler`
 *     needs from `FilePortfolioStore` so that tests can pass lightweight fakes
 *     without implementing the full store surface.
 *   - `start()` / `stop()` manage a `setInterval` timer. `runOnce()` is public
 *     so callers (and tests) can drive reconciliation manually without a timer.
 */

import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';

import type { DriftEvent, Lot, Position } from './types.js';

// ---------------------------------------------------------------------------
// RPC response shapes — narrow interfaces, no `any`
// ---------------------------------------------------------------------------

interface TokenAmountInfo {
  amount: string;
}

interface ParsedTokenInfo {
  mint: string;
  tokenAmount: TokenAmountInfo;
}

interface ParsedAccountData {
  parsed: {
    info: ParsedTokenInfo;
  };
}

interface ParsedTokenAccount {
  account: {
    data: ParsedAccountData;
  };
}

interface GetTokenAccountsByOwnerResult {
  value: ParsedTokenAccount[];
}

// ---------------------------------------------------------------------------
// Minimal store interface — only what Reconciler touches
// ---------------------------------------------------------------------------

interface PortfolioStoreMinimal {
  getAllPositions(wallet: PublicKey): Promise<Position[]>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReconcilerOpts {
  portfolioStore: PortfolioStoreMinimal;
  rpcPool: RpcPool;
  walletAddresses: PublicKey[];
  intervalMs?: number;
  onDrift?: (e: DriftEvent) => void;
}

// ---------------------------------------------------------------------------
// SPL Token program ID (mainnet-beta, devnet, testnet)
// ---------------------------------------------------------------------------

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export class Reconciler {
  readonly #store: PortfolioStoreMinimal;
  readonly #rpcPool: RpcPool;
  readonly #walletAddresses: PublicKey[];
  readonly #intervalMs: number;
  readonly #onDrift: ((e: DriftEvent) => void) | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ReconcilerOpts) {
    this.#store = opts.portfolioStore;
    this.#rpcPool = opts.rpcPool;
    this.#walletAddresses = opts.walletAddresses;
    this.#intervalMs = opts.intervalMs ?? 60_000;
    this.#onDrift = opts.onDrift;
  }

  /** Start the periodic reconciliation timer. */
  start(): void {
    this.#timer = setInterval(() => {
      void this.runOnce();
    }, this.#intervalMs);
  }

  /** Stop the periodic reconciliation timer. */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Run one reconciliation pass across all configured wallet addresses. */
  async runOnce(): Promise<void> {
    for (const wallet of this.#walletAddresses) {
      await this.#reconcileWallet(wallet);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  async #reconcileWallet(wallet: PublicKey): Promise<void> {
    const positions = await this.#store.getAllPositions(wallet);

    const raw = await this.#rpcPool.call('getTokenAccountsByOwner', [
      wallet.toBase58(),
      { programId: TOKEN_PROGRAM_ID },
      { encoding: 'jsonParsed' },
    ]);

    const result = raw as GetTokenAccountsByOwnerResult;
    const onChainByMint = new Map<string, bigint>();

    for (const acc of result.value) {
      const info = acc.account.data.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      const prev = onChainByMint.get(info.mint) ?? 0n;
      onChainByMint.set(info.mint, prev + amount);
    }

    for (const pos of positions) {
      const expected = sumLots(pos.lots);
      const observed = onChainByMint.get(pos.mint.toBase58()) ?? 0n;
      if (expected !== observed) {
        const event: DriftEvent = {
          wallet,
          mint: pos.mint,
          expected,
          observed,
          diff: observed - expected,
          lastKnownLandedSig: lastSig(pos.lots),
        };
        this.#onDrift?.(event);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sumLots(lots: Lot[]): bigint {
  return lots.reduce((acc, l) => acc + l.amount, 0n);
}

function lastSig(lots: Lot[]): string | null {
  if (lots.length === 0) return null;
  return lots[lots.length - 1]!.acquiredSig || null;
}
