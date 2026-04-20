import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import { CostBasisReconstructor } from './reconstructor.js';
import { SwapTracerRegistry } from './swap-tracer.js';
import type { CostBasisIncompleteEvent } from './types.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('11111111111111111111111111111113');

// Minimal RPC fixture factory. Only implements the two methods the
// reconstructor calls; everything else returns null. We cast to `RpcPool`
// (via `unknown`) because test stubs don't need the full EventEmitter
// surface — the reconstructor only touches `.call()`.
const fakeRpcPool = (
  sigs: Array<{ signature: string; slot: number; blockTime: number | null }>,
  txByHash: Record<string, unknown>,
): RpcPool => {
  const call = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getSignaturesForAddress') return sigs;
    if (method === 'getTransaction') {
      const [sig] = params as [string];
      return txByHash[sig] ?? null;
    }
    return null;
  });
  return { call } as unknown as RpcPool;
};

describe('CostBasisReconstructor', () => {
  it('classifies a SOL-out + token-in inflow via the heuristic as cold-start-reconstructed', async () => {
    // SOL math: pre 15_000, post 9_000, fee 5_000 → solOutflow = 15000 - 9000 - 5000 = 1000.
    // Token delta: 0 → 100. Heuristic fires, source is `cold-start-reconstructed`.
    const sigs = [{ signature: 's1', slot: 100, blockTime: Date.now() / 1000 }];
    const tx = {
      slot: 100,
      meta: {
        preBalances: [15_000n],
        postBalances: [9_000n],
        fee: 5000,
        preTokenBalances: [
          { owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '100' } },
        ],
        logMessages: [],
      },
      transaction: {
        message: { accountKeys: [wallet.toBase58()], instructions: [] },
        signatures: ['s1'],
      },
    };
    const recon = new CostBasisReconstructor({
      rpcPool: fakeRpcPool(sigs, { s1: tx }),
      tracerRegistry: new SwapTracerRegistry(),
    });
    const lots = await recon.reconstruct(wallet, mint, 100n);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.source).toBe('cold-start-reconstructed');
    expect(lots[0]!.amount).toBe(100n);
    expect(lots[0]!.costBasisLamports).toBe(1000n);
    expect(lots[0]!.acquiredSig).toBe('s1');
    expect(lots[0]!.acquiredSlot).toBe(100);
  });

  it('classifies inflow with no SOL outflow as airdrop', async () => {
    // SOL balance change equals fee (pre - post = fee) → solOutflow = 0.
    const sigs = [{ signature: 's1', slot: 100, blockTime: Date.now() / 1000 }];
    const tx = {
      slot: 100,
      meta: {
        preBalances: [10_000n],
        postBalances: [10_000n - 5000n],
        fee: 5000,
        preTokenBalances: [
          { owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '100' } },
        ],
        logMessages: [],
      },
      transaction: {
        message: { accountKeys: [wallet.toBase58()], instructions: [] },
        signatures: ['s1'],
      },
    };
    const recon = new CostBasisReconstructor({
      rpcPool: fakeRpcPool(sigs, { s1: tx }),
      tracerRegistry: new SwapTracerRegistry(),
    });
    const lots = await recon.reconstruct(wallet, mint, 100n);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.source).toBe('airdrop');
    expect(lots[0]!.costBasisLamports).toBe(0n);
    expect(lots[0]!.amount).toBe(100n);
  });

  it('emits cost-basis-incomplete when lookback hit with un-accounted balance', async () => {
    const recon = new CostBasisReconstructor({
      rpcPool: fakeRpcPool([], {}),
      tracerRegistry: new SwapTracerRegistry(),
      lookbackDays: 90,
    });
    const events: CostBasisIncompleteEvent[] = [];
    recon.on('cost-basis-incomplete', (e: CostBasisIncompleteEvent) => events.push(e));
    const lots = await recon.reconstruct(wallet, mint, 500n);
    expect(events).toHaveLength(1);
    expect(events[0]!.unaccountedAmount).toBe(500n);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.source).toBe('cold-start-unresolved');
    expect(lots[0]!.amount).toBe(500n);
    expect(lots[0]!.basisUnresolved).toBe(true);
  });
});
