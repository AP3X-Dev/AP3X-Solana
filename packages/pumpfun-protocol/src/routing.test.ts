import { describe, expect, it, vi } from 'vitest';
import type { PublicKey } from '@ap3x/solana-core';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID, PUMPFUN_PUMPSWAP_PROGRAM_ID, PUMP_AMM_SCHEMA, PUMP_SCHEMA } from '@ap3x/pumpfun-events';
import {
  accountInfo,
  bondingCurveBytes,
  globalBytes,
  globalConfigBytes,
  key,
  poolBytes,
  tokenAccountBytes,
} from './_test-accounts.js';
import { deriveBondingCurvePda, deriveBondingCurveV2Pda, deriveGlobalPda } from './curve/state.js';
import { derivePumpSwapGlobalConfigPda, derivePumpSwapPoolPda, WSOL_MINT } from './pumpswap/pool-state.js';
import { buy, sell } from './routing.js';

const MINT = key(5);
const USER = key(6);
const pad = (keys: PublicKey[], n: number) => [...keys, ...Array.from({ length: n - keys.length }, () => key(0))];

function pool(accounts: Map<string, Uint8Array>) {
  const call = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getMultipleAccounts') return { value: (params[0] as string[]).map(address => {
      const bytes = accounts.get(address); return bytes ? accountInfo(bytes).value : null;
    }) };
    if (method !== 'getAccountInfo') throw new Error(`unexpected ${method}`);
    const bytes = accounts.get(params[0] as string);
    return bytes ? accountInfo(bytes) : { value: null };
  });
  return { call } as never;
}

function chain(opts: { complete: boolean; cashback?: boolean; mayhem?: boolean }) {
  const accounts = new Map<string, Uint8Array>();
  accounts.set(
    deriveBondingCurvePda(MINT).address.toBase58(),
    bondingCurveBytes({ complete: opts.complete, creator: key(7), isCashbackCoin: opts.cashback ?? false, isMayhemMode: opts.mayhem ?? false }),
  );
  accounts.set(
    deriveGlobalPda().address.toBase58(),
    globalBytes({ feeRecipient: key(8), reservedFeeRecipient: key(15), buybackFeeRecipients: pad([key(9)], 8) }),
  );
  const poolAddr = derivePumpSwapPoolPda(MINT).address;
  accounts.set(
    poolAddr.toBase58(),
    poolBytes({ baseMint: MINT, quoteMint: WSOL_MINT, poolBaseTokenAccount: key(10), poolQuoteTokenAccount: key(11), coinCreator: key(12) }),
  );
  accounts.set(key(10).toBase58(), tokenAccountBytes(1_000_000n));
  accounts.set(key(11).toBase58(), tokenAccountBytes(2_000_000n));
  accounts.set(
    derivePumpSwapGlobalConfigPda().address.toBase58(),
    globalConfigBytes({ protocolFeeRecipients: pad([key(13)], 8), buybackFeeRecipients: pad([key(14)], 8) }),
  );
  return { rpc: pool(accounts), accounts, poolAddr };
}

const disc = (schema: typeof PUMP_SCHEMA, name: string) =>
  schema.instructions.find((i) => i.name === name)!.discriminator;
const hexData = (d: Uint8Array) => Buffer.from(d).toString('hex');
const u64At = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(at, true);

describe('buy', () => {
  it('before graduation: buy_exact_sol_in on the bonding curve with on-chain fee recipients', async () => {
    const { rpc } = chain({ complete: false });
    const ix = await buy(rpc, MINT, { user: USER, solIn: 1_000n, minTokensOut: 900n });
    expect(ix.programId.equals(PUMPFUN_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    expect(hexData(ix.data).startsWith(disc(PUMP_SCHEMA, 'buy_exact_sol_in'))).toBe(true);
    expect(u64At(ix.data, 8)).toBe(1_000n);
    expect(u64At(ix.data, 16)).toBe(900n);
    expect(ix.keys[1]!.pubkey.equals(key(8))).toBe(true); // fee_recipient from Global
    expect(ix.keys.at(-2)!.pubkey.equals(deriveBondingCurveV2Pda(MINT).address)).toBe(true);
    expect(ix.keys.at(-1)!.pubkey.equals(key(9))).toBe(true); // buyback recipient from Global
  });

  it('passes caller token program and accounts through on both paths', async () => {
    const t22 = key(21);
    const acct = key(22);
    const quote = key(23);
    const pre = await buy(chain({ complete: false }).rpc, MINT, { user: USER, solIn: 1n, minTokensOut: 1n, tokenProgram: t22, userTokenAccount: acct });
    expect(pre.keys[5]!.pubkey.equals(acct)).toBe(true);
    expect(pre.keys[8]!.pubkey.equals(t22)).toBe(true);
    const post = await sell(chain({ complete: true }).rpc, MINT, { user: USER, tokenAmount: 1n, minSolOut: 1n, tokenProgram: t22, userTokenAccount: acct, userQuoteTokenAccount: quote });
    expect(post.keys[5]!.pubkey.equals(acct)).toBe(true);
    expect(post.keys[6]!.pubkey.equals(quote)).toBe(true);
    expect(post.keys[11]!.pubkey.equals(t22)).toBe(true);
    const postBuy = await buy(chain({ complete: true }).rpc, MINT, { user: USER, solIn: 1n, minTokensOut: 1n, tokenProgram: t22, userTokenAccount: acct, userQuoteTokenAccount: quote });
    expect(postBuy.keys[6]!.pubkey.equals(quote)).toBe(true);
    const preSell = await sell(chain({ complete: false }).rpc, MINT, { user: USER, tokenAmount: 1n, minSolOut: 0n, tokenProgram: t22, userTokenAccount: acct });
    expect(preSell.keys[5]!.pubkey.equals(acct)).toBe(true);
  });

  it('mayhem-mode coins pay the reserved fee recipient', async () => {
    const { rpc } = chain({ complete: false, mayhem: true });
    const ix = await buy(rpc, MINT, { user: USER, solIn: 1_000n, minTokensOut: 1n });
    expect(ix.keys[1]!.pubkey.equals(key(15))).toBe(true);
  });

  it('after graduation: buy_exact_quote_in on the canonical PumpSwap pool', async () => {
    const { rpc, poolAddr } = chain({ complete: true });
    const ix = await buy(rpc, MINT, { user: USER, solIn: 1_000n, minTokensOut: 900n });
    expect(ix.programId.equals(PUMPFUN_PUMPSWAP_PROGRAM_ID)).toBe(true);
    expect(hexData(ix.data).startsWith(disc(PUMP_AMM_SCHEMA, 'buy_exact_quote_in'))).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(poolAddr)).toBe(true);
    expect(ix.keys[9]!.pubkey.equals(key(13))).toBe(true); // protocol fee recipient from GlobalConfig
    expect(ix.keys.at(-2)!.pubkey.equals(key(14))).toBe(true); // buyback recipient
  });

  it('after graduation but before migration: surfaces the missing pool', async () => {
    const { rpc, accounts, poolAddr } = chain({ complete: true });
    accounts.delete(poolAddr.toBase58());
    await expect(buy(rpc, MINT, { user: USER, solIn: 1n, minTokensOut: 0n })).rejects.toThrow(/account not found/);
  });
});

describe('sell', () => {
  it('before graduation: sell on the bonding curve', async () => {
    const { rpc } = chain({ complete: false });
    const ix = await sell(rpc, MINT, { user: USER, tokenAmount: 500n, minSolOut: 10n });
    expect(hexData(ix.data)).toBe(disc(PUMP_SCHEMA, 'sell') + 'f401000000000000' + '0a00000000000000');
    expect(ix.keys).toHaveLength(PUMP_SCHEMA.instructions.find((i) => i.name === 'sell')!.accounts.length + 2);
  });

  it('cashback coins pass the seller volume accumulator first', async () => {
    const { rpc } = chain({ complete: false, cashback: true });
    const ix = await sell(rpc, MINT, { user: USER, tokenAmount: 500n, minSolOut: 10n });
    expect(ix.keys).toHaveLength(PUMP_SCHEMA.instructions.find((i) => i.name === 'sell')!.accounts.length + 3);
  });

  it('after graduation: sell on PumpSwap with the caller minimum', async () => {
    const { rpc } = chain({ complete: true });
    const ix = await sell(rpc, MINT, { user: USER, tokenAmount: 500n, minSolOut: 10n });
    expect(ix.programId.equals(PUMPFUN_PUMPSWAP_PROGRAM_ID)).toBe(true);
    expect(u64At(ix.data, 8)).toBe(500n);
    expect(u64At(ix.data, 16)).toBe(10n);
  });
});
