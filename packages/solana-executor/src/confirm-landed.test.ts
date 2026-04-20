import { describe, it, expect, vi } from 'vitest';
import { confirmLanded } from './confirm-landed.js';

describe('confirmLanded', () => {
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
