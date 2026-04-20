import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { SwapTracerRegistry, type SwapTracer, type ParsedTransaction } from './swap-tracer.js';

const pid = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('11111111111111111111111111111113');

const tracer: SwapTracer = {
  programId: pid,
  trace: () => ({ kind: 'swap', solOut: 1000n, tokensIn: 100n }),
};

describe('SwapTracerRegistry', () => {
  it('registers and retrieves a tracer by programId', () => {
    const reg = new SwapTracerRegistry();
    reg.register(tracer);
    const found = reg.tracersFor(pid);
    expect(found).toHaveLength(1);
    expect(found[0]!.trace({} as unknown as ParsedTransaction, wallet, mint)).toEqual({ kind: 'swap', solOut: 1000n, tokensIn: 100n });
  });

  it('returns empty array for unknown programId', () => {
    const reg = new SwapTracerRegistry();
    const other = PublicKey.fromBase58('11111111111111111111111111111111');
    expect(reg.tracersFor(other)).toEqual([]);
  });

  it('supports multiple tracers per programId', () => {
    const reg = new SwapTracerRegistry();
    reg.register(tracer);
    reg.register({ ...tracer, trace: () => null });
    expect(reg.tracersFor(pid)).toHaveLength(2);
  });
});
