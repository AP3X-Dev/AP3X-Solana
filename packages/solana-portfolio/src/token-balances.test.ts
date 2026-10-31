import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { fetchTokenBalances } from './token-balances.js';
import { Reconciler } from './reconciler.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = '11111111111111111111111111111113';
const account = (amount: unknown) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount } } } } } });

describe('token balance evidence', () => {
  it.each([null, undefined, {}, { value: null }, { value: {} }])('refuses missing or malformed result %j', async (result) => {
    const call = vi.fn().mockResolvedValue(result);
    await expect(fetchTokenBalances({ call } as never, wallet)).rejects.toThrow('token balance');
  });

  it.each(['-1', '1.5', '1e3', '', ' 1', '01', '18446744073709551616', 1, 9007199254740992, null, undefined])('refuses inexact or noncanonical raw amount %j', async (amount) => {
    const call = vi.fn().mockResolvedValue({ value: [account(amount)] });
    await expect(fetchTokenBalances({ call } as never, wallet)).rejects.toThrow('token balance');
  });

  it.each([null, {}, { account: {} }, { account: { data: { parsed: { info: { mint: 'invalid', tokenAmount: { amount: '1' } } } } } }])('refuses malformed account evidence %j', async (row) => {
    const call = vi.fn().mockResolvedValue({ value: [row] });
    await expect(fetchTokenBalances({ call } as never, wallet)).rejects.toThrow('token balance');
  });

  it('accepts explicit empty balances and aggregates exact units from both token programs', async () => {
    const call = vi.fn().mockResolvedValueOnce({ value: [account('9007199254740993'), account('2')] })
      .mockResolvedValueOnce({ value: [account('3')] });
    expect(await fetchTokenBalances({ call } as never, wallet)).toEqual(new Map([[mint, 9007199254740998n]]));
    expect(call.mock.calls.map(([, params]) => params)).toEqual([
      [wallet.toBase58(), { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }],
      [wallet.toBase58(), { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed' }],
    ]);
    call.mockResolvedValue({ value: [] });
    expect(await fetchTokenBalances({ call } as never, wallet)).toEqual(new Map());
  });

  it('does not report drift or rebuild when the second token program is unavailable', async () => {
    const call = vi.fn().mockResolvedValueOnce({ value: [account('5')] }).mockResolvedValueOnce(null);
    const onDrift = vi.fn();
    const rebuildPosition = vi.fn();
    const getAllPositions = vi.fn().mockResolvedValue([{ mint: PublicKey.fromBase58(mint), lots: [{ amount: 10n }] }]);
    const reconciler = new Reconciler({ portfolioStore: { getAllPositions, rebuildPosition },
      rpcPool: { call } as never, walletAddresses: [wallet], onDrift });
    await expect(reconciler.runOnce()).rejects.toThrow('token balance');
    expect(onDrift).not.toHaveBeenCalled();
    expect(rebuildPosition).not.toHaveBeenCalled();
  });

  it('propagates RPC failure instead of returning an empty balance', async () => {
    const error = new Error('RPC unavailable');
    const call = vi.fn().mockRejectedValue(error);
    await expect(fetchTokenBalances({ call } as never, wallet)).rejects.toBe(error);
  });
});
