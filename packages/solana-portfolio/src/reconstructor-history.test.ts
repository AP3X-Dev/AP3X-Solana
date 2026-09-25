import { describe, expect, it, vi } from 'vitest';
import { base58, PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import { CostBasisReconstructor } from './reconstructor.js';
import { SwapTracerRegistry, type ParsedTransaction, type SwapTracer } from './swap-tracer.js';

const wallet = PublicKey.fromBase58('11111111111111111111111111111112');
const mint = PublicKey.fromBase58('11111111111111111111111111111113');
const other = PublicKey.fromBase58('11111111111111111111111111111114');
const now = () => Math.floor(Date.now() / 1000);

/** A tx where the wallet's token balance goes pre → post and it spends `solOut` beyond the fee. */
function tx(slot: number, pre: bigint, post: bigint, solOut: bigint, extra: Record<string, unknown> = {}) {
  const tb = (amount: bigint) => [{ owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: amount.toString() } }];
  return {
    slot,
    meta: {
      preBalances: [1_000_000n],
      postBalances: [1_000_000n - 5_000n - solOut],
      fee: 5_000,
      preTokenBalances: pre > 0n ? tb(pre) : [],
      postTokenBalances: post > 0n ? tb(post) : [],
      logMessages: [],
      ...extra,
    },
    transaction: { message: { accountKeys: [wallet.toBase58()], instructions: [] }, signatures: [`s${slot}`] },
  };
}

/** Newest-first history; `pageSize` simulates getSignaturesForAddress paging. */
function rpc(history: Array<{ slot: number; tx: unknown }>) {
  const sigs = history.map((h) => ({ signature: `s${h.slot}`, slot: h.slot, blockTime: now() }));
  const byHash = Object.fromEntries(history.map((h) => [`s${h.slot}`, h.tx]));
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const call = vi.fn(async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (method === 'getSignaturesForAddress') {
      const before = (params[1] as { before?: string }).before;
      const start = before ? sigs.findIndex((s) => s.signature === before) + 1 : 0;
      return sigs.slice(start, start + 1000);
    }
    if (method === 'getTransaction') return byHash[params[0] as string] ?? null;
    return null;
  });
  return { pool: { call } as unknown as RpcPool, calls };
}

const recon = (pool: RpcPool, extra = {}) =>
  new CostBasisReconstructor({ rpcPool: pool, tracerRegistry: new SwapTracerRegistry(), ...extra });

describe('CostBasisReconstructor history replay', () => {
  it('buy, partial sell, buy leaves the right lots (FIFO)', async () => {
    // Oldest → newest: buy 100 for 1000, sell 60, buy 50 for 900. Holding 90.
    const { pool } = rpc([
      { slot: 3, tx: tx(3, 40n, 90n, 900n) },
      { slot: 2, tx: tx(2, 100n, 40n, 0n) },
      { slot: 1, tx: tx(1, 0n, 100n, 1_000n) },
    ]);
    const lots = await recon(pool).reconstruct(wallet, mint, 90n);
    expect(lots.map((l) => [l.amount, l.costBasisLamports, l.acquiredSig])).toEqual([
      [40n, 400n, 's1'],
      [50n, 900n, 's3'],
    ]);
  });

  it('stops walking at the transaction that opened the current position', async () => {
    const { pool, calls } = rpc([
      { slot: 5, tx: tx(5, 0n, 10n, 100n) }, // opened here
      { slot: 4, tx: tx(4, 10n, 0n, 0n) }, // older, closed position — never fetched
      { slot: 3, tx: tx(3, 0n, 10n, 50n) },
    ]);
    await recon(pool).reconstruct(wallet, mint, 10n);
    const fetched = calls.filter((c) => c.method === 'getTransaction').map((c) => c.params[0]);
    expect(fetched).toEqual(['s5']);
  });

  it('pages through more than one page of signatures', async () => {
    const noise = Array.from({ length: 1_500 }, (_, i) => ({ slot: 2_000 - i, tx: tx(2_000 - i, 0n, 0n, 0n) }));
    const { pool, calls } = rpc([...noise, { slot: 1, tx: tx(1, 0n, 7n, 70n) }]);
    const lots = await recon(pool).reconstruct(wallet, mint, 7n);
    expect(lots).toEqual([expect.objectContaining({ amount: 7n, costBasisLamports: 70n, acquiredSig: 's1' })]);
    expect(calls.filter((c) => c.method === 'getSignaturesForAddress')).toHaveLength(2);
  });

  it('requests v1 transactions', async () => {
    const { pool, calls } = rpc([{ slot: 1, tx: tx(1, 0n, 1n, 1n) }]);
    await recon(pool).reconstruct(wallet, mint, 1n);
    expect(calls.find((c) => c.method === 'getTransaction')!.params[1]).toMatchObject({ maxSupportedTransactionVersion: 1 });
  });

  it('seeds an unresolved lot for balance held before the walk and sells it first', async () => {
    const { pool } = rpc([
      { slot: 2, tx: tx(2, 30n, 10n, 0n) }, // sell 20 of the unknown 30
      { slot: 1, tx: tx(1, 20n, 30n, 100n) }, // buy 10; 20 held before history
    ]);
    const events: unknown[] = [];
    const r = recon(pool);
    r.on('cost-basis-incomplete', (e) => events.push(e));
    const lots = await r.reconstruct(wallet, mint, 10n);
    expect(lots).toEqual([expect.objectContaining({ amount: 10n, costBasisLamports: 100n, acquiredSig: 's1' })]);
    expect(events).toHaveLength(0);
  });

  it('transfer-ins take their basis from the hook, keyed by the sender', async () => {
    const transfer = tx(1, 0n, 50n, 0n, {
      preTokenBalances: [{ owner: other.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '80' } }],
      postTokenBalances: [
        { owner: other.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '30' } },
        { owner: wallet.toBase58(), mint: mint.toBase58(), uiTokenAmount: { amount: '50' } },
      ],
    });
    const transferBasis = vi.fn(({ source }: { source: PublicKey | undefined }) => (source?.equals(other) ? 123n : undefined));
    const { pool } = rpc([{ slot: 1, tx: transfer }]);
    const withHook = await recon(pool, { transferBasis }).reconstruct(wallet, mint, 50n);
    expect(withHook).toEqual([expect.objectContaining({ source: 'transfer-in', costBasisLamports: 123n })]);
    expect(withHook[0]!.basisUnresolved).toBeUndefined();

    const withoutHook = await recon(pool).reconstruct(wallet, mint, 50n);
    expect(withoutHook).toEqual([expect.objectContaining({ source: 'transfer-in', basisUnresolved: true })]);
  });

  it('gives tracers lookup-table accounts, base58 instruction data and balances', async () => {
    const program = PublicKey.fromBase58('11111111111111111111111111111115');
    const altAccount = PublicKey.fromBase58('11111111111111111111111111111116');
    const seen: ParsedTransaction[] = [];
    const tracer: SwapTracer = {
      programId: program,
      trace: (t) => {
        seen.push(t);
        return { kind: 'swap', solOut: 42n, tokensIn: 5n };
      },
    };
    const registry = new SwapTracerRegistry();
    registry.register(tracer);
    const withIx = tx(1, 0n, 5n, 42n);
    withIx.transaction.message.accountKeys = [wallet.toBase58()];
    (withIx.transaction.message as { instructions: unknown[] }).instructions = [
      { programIdIndex: 2, accounts: [0, 1], data: base58.encode(new Uint8Array([9, 8, 7])) },
    ];
    (withIx.meta as Record<string, unknown>).loadedAddresses = { writable: [altAccount.toBase58()], readonly: [program.toBase58()] };

    const { pool } = rpc([{ slot: 1, tx: withIx }]);
    const lots = await new CostBasisReconstructor({ rpcPool: pool, tracerRegistry: registry }).reconstruct(wallet, mint, 5n);
    expect(lots[0]).toMatchObject({ costBasisLamports: 42n, source: 'cold-start-reconstructed' });
    const ix = seen[0]!.instructions[0]!;
    expect(ix.programId.equals(program)).toBe(true);
    expect(ix.accounts.map((a) => a.toBase58())).toEqual([wallet.toBase58(), altAccount.toBase58()]);
    expect([...ix.data]).toEqual([9, 8, 7]);
    expect(seen[0]!.meta.postTokenBalances[0]!.amount).toBe(5n);
    expect(seen[0]!.meta.preBalances.get(wallet.toBase58())).toBe(1_000_000n);
  });
});
