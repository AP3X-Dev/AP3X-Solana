import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { parseLogs, walkInvocations } from '@ap3x/solana-events';
import { pumpSwapDecoder, type PumpSwapCreatePoolEvent } from '@ap3x/pumpfun-events';
import { accountInfo, globalConfigBytes, key, poolBytes, tokenAccountBytes } from '../_test-accounts.js';
import { AccountLayoutError } from '../curve/state.js';
import {
  decodePumpSwapGlobalConfig,
  decodePumpSwapPool,
  derivePoolAuthorityPda,
  derivePumpSwapPoolPda,
  pumpSwapPoolState,
  WSOL_MINT,
} from './pool-state.js';

const MINT = key(5);

describe('derivePumpSwapPoolPda', () => {
  it('matches the pool of a real mainnet migration', () => {
    // CreatePoolEvent captured from a real pump.fun migration (see the
    // pumpfun-events per-variant fixture): the canonical pool must be derivable
    // from the mint alone.
    const fixture = fileURLToPath(
      new URL('../../../pumpfun-events/tests/fixtures/pumpfun-per-variant.jsonl.gz', import.meta.url),
    );
    const line = gunzipSync(readFileSync(fixture))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { variantHint: string; logs: string[] })
      .find((l) => l.variantHint === 'pumpswap.create_pool');
    expect(line, 'fixture has a create_pool transaction').toBeDefined();
    const event = [...walkInvocations(parseLogs(line!.logs))]
      .map(({ chunk }) => pumpSwapDecoder.decode(chunk))
      .find((e): e is PumpSwapCreatePoolEvent => e.kind === 'pumpswap.create_pool');
    expect(event).toBeDefined();
    expect(event!.index).toBe(0);
    expect(event!.creator.equals(derivePoolAuthorityPda(event!.baseMint).address)).toBe(true);
    expect(derivePumpSwapPoolPda(event!.baseMint, event!.quoteMint).address.toBase58()).toBe(event!.pool.toBase58());
  });

  it('defaults the quote mint to WSOL and differs per mint', () => {
    expect(derivePumpSwapPoolPda(MINT).address.equals(derivePumpSwapPoolPda(MINT, WSOL_MINT).address)).toBe(true);
    expect(derivePumpSwapPoolPda(MINT).address.equals(derivePumpSwapPoolPda(key(6)).address)).toBe(false);
  });
});

describe('decodePumpSwapPool', () => {
  it('decodes the Pool layout', () => {
    const pool = key(1);
    const p = decodePumpSwapPool(
      poolBytes({
        index: 0,
        creator: key(2),
        baseMint: MINT,
        quoteMint: WSOL_MINT,
        lpMint: key(3),
        poolBaseTokenAccount: key(10),
        poolQuoteTokenAccount: key(11),
        lpSupply: 42n,
        coinCreator: key(4),
        isCashbackCoin: true,
      }),
      pool,
    );
    expect(p.pool.equals(pool)).toBe(true);
    expect(p.baseMint.equals(MINT)).toBe(true);
    expect(p.poolQuoteTokenAccount.equals(key(11))).toBe(true);
    expect(p.coinCreator.equals(key(4))).toBe(true);
    expect(p.lpSupply).toBe(42n);
    expect(p.isCashbackCoin).toBe(true);
  });

  it('rejects other account types', () => {
    expect(() => decodePumpSwapPool(globalConfigBytes({}), key(1))).toThrow(AccountLayoutError);
  });
});

describe('pumpSwapPoolState', () => {
  it('reads reserves from the pool token accounts', async () => {
    const accounts = new Map<string, Uint8Array>([
      [key(1).toBase58(), poolBytes({ baseMint: MINT, quoteMint: WSOL_MINT, poolBaseTokenAccount: key(10), poolQuoteTokenAccount: key(11) })],
      [key(10).toBase58(), tokenAccountBytes(1_000n)],
      [key(11).toBase58(), tokenAccountBytes(2_000n)],
    ]);
    const call = vi.fn(async (_m: string, params: unknown[]) => accountInfo(accounts.get(params[0] as string)!));
    const state = await pumpSwapPoolState({ call } as never, key(1));
    expect(state.baseReserves).toBe(1_000n);
    expect(state.quoteReserves).toBe(2_000n);
  });

  it('throws when the pool does not exist', async () => {
    const call = vi.fn(async () => ({ value: null }));
    await expect(pumpSwapPoolState({ call } as never, key(1))).rejects.toThrow(/account not found/);
  });
});

describe('decodePumpSwapGlobalConfig', () => {
  it('returns fees and non-zero recipients', () => {
    const cfg = decodePumpSwapGlobalConfig(
      globalConfigBytes({
        lpFeeBasisPoints: 20n,
        protocolFeeBasisPoints: 5n,
        coinCreatorFeeBasisPoints: 5n,
        protocolFeeRecipients: [key(1), key(0), key(0), key(0), key(0), key(0), key(0), key(0)],
        buybackFeeRecipients: [key(2), key(3), key(0), key(0), key(0), key(0), key(0), key(0)],
      }),
    );
    expect(cfg.lpFeeBasisPoints).toBe(20n);
    expect(cfg.protocolFeeRecipients.map(String)).toEqual([key(1).toBase58()]);
    expect(cfg.buybackFeeRecipients).toHaveLength(2);
  });
});
