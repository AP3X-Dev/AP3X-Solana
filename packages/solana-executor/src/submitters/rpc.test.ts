import { describe, it, expect, vi } from 'vitest';
import { RpcSubmitter } from './rpc.js';

describe('RpcSubmitter', () => {
  it('calls sendTransaction on the pool (pinned write endpoint path)', async () => {
    const calls: Array<{ m: string; p: unknown[] }> = [];
    const rpcPool: any = {
      pinForWrite: vi.fn(() => ({ name: 'helius', url: 'https://helius.example', kind: 'http' })),
      call: vi.fn(async (m: string, p: unknown[]) => {
        calls.push({ m, p });
        return 'sig123';
      }),
    };
    const sub = new RpcSubmitter({ rpcPool });
    const ack = await sub.submit({ kind: 'tx', signedTx: new Uint8Array([1, 2, 3]) });
    expect(ack.signature).toBe('sig123');
    expect(ack.submitterUsed).toBe('rpc');
    expect(calls[0]!.m).toBe('sendTransaction');
  });

  it('rejects bundle payloads', async () => {
    const rpcPool: any = {
      pinForWrite: vi.fn(() => ({ name: 'helius', url: 'https://helius.example', kind: 'http' })),
      call: vi.fn(),
    };
    const sub = new RpcSubmitter({ rpcPool });
    await expect(sub.submit({ kind: 'bundle', signedTxs: [], tipLamports: 0n })).rejects.toThrow();
  });

  it('reports healthy with lastOkAt after successful submit', async () => {
    const rpcPool: any = {
      pinForWrite: vi.fn(() => ({ name: 'helius', url: 'https://helius.example', kind: 'http' })),
      call: vi.fn(async () => 'sig456'),
    };
    const sub = new RpcSubmitter({ rpcPool });
    expect(sub.health().state).toBe('healthy');
    const before = Date.now();
    await sub.submit({ kind: 'tx', signedTx: new Uint8Array([4, 5, 6]) });
    const h = sub.health();
    expect(h.state).toBe('healthy');
    expect(h.lastOkAt).toBeGreaterThanOrEqual(before);
  });
});
