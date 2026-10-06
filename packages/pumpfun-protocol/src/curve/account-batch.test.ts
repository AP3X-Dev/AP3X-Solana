import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { fetchAccountDataBatch } from './state.js';
const key = (n: number) => PublicKey.fromBytes(new Uint8Array(32).fill(n));
const accounts = [{ address: key(1), label: 'base' }, { address: key(2), label: 'quote' }];
const value = () => [{ data: ['AQ==', 'base64'] }, { data: ['Ag==', 'base64'] }];
describe('fresh grouped account reads', () => {
  it('preserves ordered bytes, exact slice options and fresh responses', async () => {
    let replies = value(); const call = vi.fn(async () => ({ value: replies }));
    const rpc = { call } as never;
    expect(await fetchAccountDataBatch(rpc, accounts, { offset: 0, length: 12 })).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
    expect(call.mock.calls[0]).toEqual(['getMultipleAccounts', [accounts.map(a => a.address.toBase58()),
      { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 12 } }]]);
    replies = [{ data: ['Aw==', 'base64'] }, { data: ['BA==', 'base64'] }];
    expect(await fetchAccountDataBatch(rpc, accounts)).toEqual([new Uint8Array([3]), new Uint8Array([4])]);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it.each(['short', 'missing', 'null', 'encoding', 'invalid-base64', 'no-data'] as const)('rejects %s responses without fallback reads', async mode => {
    const values: unknown[] = value();
    if (mode === 'short') values.pop();
    if (mode === 'null') values[1] = null;
    if (mode === 'encoding') values[1] = { data: ['Ag==', 'base58'] };
    if (mode === 'invalid-base64') values[1] = { data: ['not base64', 'base64'] };
    if (mode === 'no-data') values[1] = {};
    const call = vi.fn(async () => mode === 'missing' ? {} : { value: values });
    await expect(fetchAccountDataBatch({ call } as never, accounts)).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch empty or invalid batches/slices', async () => {
    const call = vi.fn();
    expect(await fetchAccountDataBatch({ call } as never, [])).toEqual([]);
    await expect(fetchAccountDataBatch({ call } as never, Array.from({ length: 101 }, () => accounts[0]!))).rejects.toThrow('bounds');
    await expect(fetchAccountDataBatch({ call } as never, accounts, { offset: -1, length: 12 })).rejects.toThrow('slice');
    expect(call).not.toHaveBeenCalled();
  });
});
