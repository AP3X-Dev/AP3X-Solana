import { describe, it, expect, vi } from 'vitest';
import { confirmLanded } from './confirm-landed.js';

describe('confirmLanded', () => {
  it('accepts finalized status without fetching a transaction or waiting', async () => {
    const rpcPool: any = { call: vi.fn(async () => ({ value: [{ slot: 101, confirmationStatus: 'finalized', err: null }] })) };
    expect(await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 1000 })).toMatchObject({ kind: 'landed', slot: 101 });
    expect(rpcPool.call).toHaveBeenCalledTimes(1);
  });

  it('does not promote processed status to landed', async () => {
    const rpcPool: any = { call: vi.fn()
      .mockResolvedValueOnce({ value: [{ slot: 100, confirmationStatus: 'processed', err: null }] })
      .mockResolvedValueOnce({ value: [{ slot: 101, confirmationStatus: 'confirmed', err: null }] }) };
    const result = await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 1000, pollIntervalMs: 1 });
    expect(result).toMatchObject({ kind: 'landed', slot: 101 });
    expect(rpcPool.call).toHaveBeenCalledTimes(2);
  });

  it('retains reverted transaction logs and preserves missing logs as an empty list', async () => {
    for (const [tx, logs] of [[null, []], [{}, []], [{ meta: {} }, []], [{ meta: { logMessages: ['program failed'] } }, ['program failed']]] as const) {
      const rpcPool: any = { call: vi.fn()
        .mockResolvedValueOnce({ value: [{ slot: 100, confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom 1'] } }] })
        .mockResolvedValueOnce(tx) };
      expect(await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 1000 })).toEqual({
        kind: 'reverted', slot: 100, logs, error: JSON.stringify({ InstructionError: [0, 'Custom 1'] }),
      });
    }
  });

  it('does not report success when the provider rejects the status read', async () => {
    const rpcPool: any = { call: vi.fn().mockRejectedValue(new Error('provider unavailable')) };
    await expect(confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 1000 })).rejects.toThrow('provider unavailable');
  });
  it('resolves landed when getSignatureStatuses returns confirmation', async () => {
    let calls = 0;
    const rpcPool: any = {
      call: vi.fn(async () => {
        calls++;
        if (calls < 3) return { value: [null] };
        return { value: [{ slot: 100, confirmationStatus: 'confirmed', err: null }] };
      }),
    };
    const result = await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 5000, pollIntervalMs: 5 });
    expect(result.kind).toBe('landed');
    if (result.kind === 'landed') expect(result.slot).toBe(100);
  });

  it('returns timeout when deadline exceeded', async () => {
    const rpcPool: any = { call: vi.fn(async () => ({ value: [null] })) };
    const result = await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 50, pollIntervalMs: 10 });
    expect(result.kind).toBe('timeout');
  });

  it('returns reverted when err present', async () => {
    const rpcPool: any = {
      call: vi.fn(async () => ({ value: [{ slot: 100, confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom 1'] } }] })),
    };
    const result = await confirmLanded({ rpcPool, signature: 'sig', deadline: Date.now() + 1000, pollIntervalMs: 5 });
    expect(result.kind).toBe('reverted');
  });
});
