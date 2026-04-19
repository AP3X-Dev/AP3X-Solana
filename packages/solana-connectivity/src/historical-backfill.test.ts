/**
 * RpcHistoricalBackfill tests.
 *
 * These exercise thin wrapper logic over a fake `RpcPool`:
 *   - Method routing (signatures / tx / blocks forwarded as JSON-RPC calls)
 *   - Chunking of long `getBlocks` ranges
 *   - Pagination through `iterateSignaturesForAddress`
 *   - Async-generator semantics of `fetchEventsForProgram` including the
 *     "decoder throws → unknown channel + keep iterating" contract.
 *
 * No msw here — the pool itself is msw-tested in `rpc-pool.test.ts`. These
 * tests only assert the wrapper forwards correctly and composes pagination
 * + chunking + decoder invocation.
 */

import { describe, it, expect, vi } from 'vitest';

import type { RpcPool } from './rpc-pool';
import {
  RpcHistoricalBackfill,
  type DecodedEvent,
  type EventDecodeResult,
  type TransactionDecoder,
  type UnknownEventDecode,
} from './historical-backfill';

// ---------------------------------------------------------------------------
// Fake RpcPool
// ---------------------------------------------------------------------------

type PoolCall = (method: string, params: unknown) => Promise<unknown>;

function mkPool(impl: PoolCall): { pool: RpcPool; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(impl);
  const pool = { call } as unknown as RpcPool;
  return { pool, call };
}

// ---------------------------------------------------------------------------
// getSignaturesForAddress — single page
// ---------------------------------------------------------------------------

describe('RpcHistoricalBackfill.getSignaturesForAddress', () => {
  it('forwards to the pool with address + options', async () => {
    const { pool, call } = mkPool(async () => [
      { signature: 'sig1', slot: 100 },
      { signature: 'sig2', slot: 101 },
    ]);
    const backfill = new RpcHistoricalBackfill(pool);
    const result = await backfill.getSignaturesForAddress('addr1', {
      limit: 10,
      commitment: 'confirmed',
    });
    expect(call).toHaveBeenCalledWith('getSignaturesForAddress', [
      'addr1',
      { limit: 10, commitment: 'confirmed' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ signature: 'sig1', slot: 100 });
  });

  it('sends an empty options object when no options provided', async () => {
    const { pool, call } = mkPool(async () => []);
    const backfill = new RpcHistoricalBackfill(pool);
    await backfill.getSignaturesForAddress('addr1');
    expect(call).toHaveBeenCalledWith('getSignaturesForAddress', ['addr1', {}]);
  });

  it('omits undefined fields in the options object', async () => {
    const { pool, call } = mkPool(async () => []);
    const backfill = new RpcHistoricalBackfill(pool);
    await backfill.getSignaturesForAddress('addr1', { limit: 5 });
    expect(call).toHaveBeenCalledWith('getSignaturesForAddress', [
      'addr1',
      { limit: 5 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// iterateSignaturesForAddress — pagination
// ---------------------------------------------------------------------------

describe('RpcHistoricalBackfill.iterateSignaturesForAddress', () => {
  it('follows the before cursor across pages until short page', async () => {
    // Simulate 3 pages: [10 sigs, 10 sigs, 3 sigs]. Pagination stops when
    // the page size is < limit.
    const pages = [
      Array.from({ length: 10 }, (_, i) => ({ signature: `a${i}`, slot: 100 - i })),
      Array.from({ length: 10 }, (_, i) => ({
        signature: `b${i}`,
        slot: 90 - i,
      })),
      Array.from({ length: 3 }, (_, i) => ({ signature: `c${i}`, slot: 80 - i })),
    ];
    let pageIdx = 0;
    const { pool, call } = mkPool(async (_method, _params) => {
      const page = pages[pageIdx++];
      return page ?? [];
    });

    const backfill = new RpcHistoricalBackfill(pool);
    const collected: { signature: string; slot: number }[] = [];
    for await (const sig of backfill.iterateSignaturesForAddress('addr1', {
      limit: 10,
    })) {
      collected.push(sig);
    }
    expect(collected).toHaveLength(23);
    // Page 1: no before.
    expect(call.mock.calls[0]).toEqual([
      'getSignaturesForAddress',
      ['addr1', { limit: 10 }],
    ]);
    // Page 2: before = last sig of page 1.
    expect(call.mock.calls[1]).toEqual([
      'getSignaturesForAddress',
      ['addr1', { limit: 10, before: 'a9' }],
    ]);
    // Page 3: before = last sig of page 2.
    expect(call.mock.calls[2]).toEqual([
      'getSignaturesForAddress',
      ['addr1', { limit: 10, before: 'b9' }],
    ]);
    // No 4th call because page 3 was short.
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('stops immediately on first empty page', async () => {
    const { pool, call } = mkPool(async () => []);
    const backfill = new RpcHistoricalBackfill(pool);
    const collected = [];
    for await (const sig of backfill.iterateSignaturesForAddress('addr1')) {
      collected.push(sig);
    }
    expect(collected).toEqual([]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('respects maxPages cap', async () => {
    const { pool, call } = mkPool(async () => [
      { signature: 's1', slot: 1 },
      { signature: 's2', slot: 2 },
    ]);
    const backfill = new RpcHistoricalBackfill(pool);
    const collected = [];
    for await (const sig of backfill.iterateSignaturesForAddress('addr1', {
      limit: 2,
      maxPages: 3,
    })) {
      collected.push(sig);
    }
    expect(collected).toHaveLength(6);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('defaults to limit=1000 when none supplied', async () => {
    const { pool, call } = mkPool(async () => []);
    const backfill = new RpcHistoricalBackfill(pool);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of backfill.iterateSignaturesForAddress('addr1')) {
      // nothing — empty page stops iteration
    }
    expect(call).toHaveBeenCalledWith('getSignaturesForAddress', [
      'addr1',
      { limit: 1000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getTransaction
// ---------------------------------------------------------------------------

describe('RpcHistoricalBackfill.getTransaction', () => {
  it('forwards signature + options with a default maxSupportedTransactionVersion', async () => {
    const { pool, call } = mkPool(async () => ({
      slot: 100,
      transaction: { message: {} },
      meta: {},
    }));
    const backfill = new RpcHistoricalBackfill(pool);
    const tx = await backfill.getTransaction('sigA');
    expect(call).toHaveBeenCalledWith('getTransaction', [
      'sigA',
      { maxSupportedTransactionVersion: 0 },
    ]);
    expect(tx).toMatchObject({ slot: 100 });
  });

  it('passes through encoding + commitment overrides', async () => {
    const { pool, call } = mkPool(async () => null);
    const backfill = new RpcHistoricalBackfill(pool);
    await backfill.getTransaction('sigA', {
      encoding: 'jsonParsed',
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    expect(call).toHaveBeenCalledWith('getTransaction', [
      'sigA',
      {
        encoding: 'jsonParsed',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      },
    ]);
  });

  it('returns null when the node returns null (tx not found)', async () => {
    const { pool } = mkPool(async () => null);
    const backfill = new RpcHistoricalBackfill(pool);
    expect(await backfill.getTransaction('sigX')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getBlocks — chunking
// ---------------------------------------------------------------------------

describe('RpcHistoricalBackfill.getBlocks', () => {
  it('forwards a single-chunk range unchanged', async () => {
    const { pool, call } = mkPool(async (_method, params) => {
      const [from, to] = params as [number, number];
      const out = [];
      for (let s = from; s <= to; s++) out.push(s);
      return out;
    });
    const backfill = new RpcHistoricalBackfill(pool);
    const blocks = await backfill.getBlocks(0, 500);
    expect(blocks).toHaveLength(501);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('getBlocks', [0, 500]);
  });

  it('chunks ranges longer than 1000 slots into 1000-slot windows', async () => {
    const { pool, call } = mkPool(async (_method, params) => {
      const [from, to] = params as [number, number];
      // Simulate sparse blocks: return every other slot
      const out = [];
      for (let s = from; s <= to; s += 2) out.push(s);
      return out;
    });
    const backfill = new RpcHistoricalBackfill(pool);
    const blocks = await backfill.getBlocks(0, 2500);
    // Chunk windows: [0, 999], [1000, 1999], [2000, 2500]
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[0]).toEqual(['getBlocks', [0, 999]]);
    expect(call.mock.calls[1]).toEqual(['getBlocks', [1000, 1999]]);
    expect(call.mock.calls[2]).toEqual(['getBlocks', [2000, 2500]]);
    // Results concatenated in order.
    expect(blocks.slice(0, 3)).toEqual([0, 2, 4]);
    // Highest slot within [2000, 2500] stepping by 2 is 2500.
    expect(blocks[blocks.length - 1]).toBe(2500);
  });

  it('returns [] for an empty range (from > to)', async () => {
    const { pool, call } = mkPool(async () => [0]);
    const backfill = new RpcHistoricalBackfill(pool);
    const blocks = await backfill.getBlocks(100, 50);
    expect(blocks).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it('uses a single chunk at exactly the chunk boundary', async () => {
    const { pool, call } = mkPool(async () => []);
    const backfill = new RpcHistoricalBackfill(pool);
    await backfill.getBlocks(0, 999);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('getBlocks', [0, 999]);
  });
});

// ---------------------------------------------------------------------------
// fetchEventsForProgram — async generator
// ---------------------------------------------------------------------------

const PROGRAM_ID = 'Prog1111111111111111111111111111111111111111';

describe('RpcHistoricalBackfill.fetchEventsForProgram', () => {
  it('yields decoded + unknown events from the decoder', async () => {
    const pool = mkProgramPool({
      blocks: [10, 11],
      sigsByBlock: {
        10: ['sig-a'],
        11: ['sig-b'],
      },
      tx: (sig) => ({ slot: sig === 'sig-a' ? 10 : 11, sig }),
    });
    const backfill = new RpcHistoricalBackfill(pool);
    const decoder: TransactionDecoder = (tx) => {
      const { slot, sig } = tx as { slot: number; sig: string };
      if (sig === 'sig-a') {
        return {
          kind: 'decoded',
          slot,
          signature: sig,
          programId: PROGRAM_ID,
          data: { parsed: true },
        } satisfies DecodedEvent;
      }
      return {
        kind: 'unknown',
        slot,
        signature: sig,
        programId: PROGRAM_ID,
        reason: 'variant not registered',
      } satisfies UnknownEventDecode;
    };

    const events: EventDecodeResult[] = [];
    for await (const ev of backfill.fetchEventsForProgram(
      PROGRAM_ID,
      { fromSlot: 10, toSlot: 11 },
      decoder,
    )) {
      events.push(ev);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'decoded', signature: 'sig-a' });
    expect(events[1]).toMatchObject({ kind: 'unknown', signature: 'sig-b' });
  });

  it('iterates lazily — only the first tx is fetched if the consumer breaks', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const pool = mkProgramPool(
      {
        blocks: [10, 11, 12],
        sigsByBlock: {
          10: ['s10'],
          11: ['s11'],
          12: ['s12'],
        },
        tx: (sig) => ({ slot: Number(sig.slice(1)), sig }),
      },
      calls,
    );
    const backfill = new RpcHistoricalBackfill(pool);
    const decoder: TransactionDecoder = (tx) => {
      const { slot, sig } = tx as { slot: number; sig: string };
      return {
        kind: 'decoded',
        slot,
        signature: sig,
        programId: PROGRAM_ID,
        data: null,
      };
    };
    const iter = backfill.fetchEventsForProgram(
      PROGRAM_ID,
      { fromSlot: 10, toSlot: 12 },
      decoder,
    );
    const first = await iter.next();
    expect(first.value).toMatchObject({ kind: 'decoded', signature: 's10' });
    // Now bail out. The generator's try/finally path should release the iterator
    // cleanly and no further getTransaction calls should fire.
    await iter.return?.(undefined);

    const getTxCount = calls.filter((c) => c.method === 'getTransaction').length;
    expect(getTxCount).toBe(1);
  });

  it('surfaces decoder throws via an UnknownEventDecode without halting iteration', async () => {
    const pool = mkProgramPool({
      blocks: [10, 11, 12],
      sigsByBlock: {
        10: ['s10'],
        11: ['s11-bad'],
        12: ['s12'],
      },
      tx: (sig) => ({ slot: Number(sig.slice(1, 3)), sig }),
    });
    const backfill = new RpcHistoricalBackfill(pool);
    const decoder: TransactionDecoder = (tx) => {
      const { slot, sig } = tx as { slot: number; sig: string };
      if (sig === 's11-bad') {
        throw new Error('borsh layout mismatch');
      }
      return {
        kind: 'decoded',
        slot,
        signature: sig,
        programId: PROGRAM_ID,
        data: null,
      };
    };

    const events: EventDecodeResult[] = [];
    for await (const ev of backfill.fetchEventsForProgram(
      PROGRAM_ID,
      { fromSlot: 10, toSlot: 12 },
      decoder,
    )) {
      events.push(ev);
    }
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: 'decoded', signature: 's10' });
    expect(events[1]).toMatchObject({
      kind: 'unknown',
      signature: 's11-bad',
      reason: expect.stringContaining('borsh'),
    });
    expect(events[2]).toMatchObject({ kind: 'decoded', signature: 's12' });
  });

  it('yields nothing for an empty slot range', async () => {
    const pool = mkProgramPool({
      blocks: [],
      sigsByBlock: {},
      tx: () => null,
    });
    const backfill = new RpcHistoricalBackfill(pool);
    const decoder = vi.fn((): EventDecodeResult => {
      throw new Error('unreachable');
    });
    const events: EventDecodeResult[] = [];
    for await (const ev of backfill.fetchEventsForProgram(
      PROGRAM_ID,
      { fromSlot: 50, toSlot: 49 }, // empty
      decoder,
    )) {
      events.push(ev);
    }
    expect(events).toEqual([]);
    expect(decoder).not.toHaveBeenCalled();
  });

  it('skips transactions that the node returns as null', async () => {
    const pool = mkProgramPool({
      blocks: [10],
      sigsByBlock: { 10: ['s-miss', 's-ok'] },
      tx: (sig) => (sig === 's-miss' ? null : { slot: 10, sig }),
    });
    const backfill = new RpcHistoricalBackfill(pool);
    const decoder: TransactionDecoder = (tx) => {
      const { slot, sig } = tx as { slot: number; sig: string };
      return {
        kind: 'decoded',
        slot,
        signature: sig,
        programId: PROGRAM_ID,
        data: null,
      };
    };
    const events: EventDecodeResult[] = [];
    for await (const ev of backfill.fetchEventsForProgram(
      PROGRAM_ID,
      { fromSlot: 10, toSlot: 10 },
      decoder,
    )) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ signature: 's-ok' });
  });

  it('accepts a decoder returning an array of results', async () => {
    const pool = mkProgramPool({
      blocks: [10],
      sigsByBlock: { 10: ['multi'] },
      tx: () => ({ slot: 10 }),
    });
    const backfill = new RpcHistoricalBackfill(pool);
    const decoder: TransactionDecoder = () => [
      {
        kind: 'decoded',
        slot: 10,
        signature: 'multi',
        programId: PROGRAM_ID,
        data: { idx: 0 },
      },
      {
        kind: 'decoded',
        slot: 10,
        signature: 'multi',
        programId: PROGRAM_ID,
        data: { idx: 1 },
      },
    ];
    const events: EventDecodeResult[] = [];
    for await (const ev of backfill.fetchEventsForProgram(
      PROGRAM_ID,
      { fromSlot: 10, toSlot: 10 },
      decoder,
    )) {
      events.push(ev);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ data: { idx: 0 } });
    expect(events[1]).toMatchObject({ data: { idx: 1 } });
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface ProgramPoolSpec {
  blocks: number[];
  sigsByBlock: Record<number, string[]>;
  tx: (sig: string) => unknown;
}

/**
 * Build a fake RpcPool that answers:
 *   - `getBlocks(from, to)` with spec.blocks filtered into [from, to]
 *   - `getSignaturesForAddress(programId, { minContextSlot, ... })` with
 *     every sig in spec.sigsByBlock[minContextSlot]
 *   - `getTransaction(sig)` with spec.tx(sig)
 *
 * The optional `calls` array is populated with every call made, for
 * assertions about laziness.
 */
function mkProgramPool(
  spec: ProgramPoolSpec,
  calls?: { method: string; params: unknown }[],
): RpcPool {
  const impl: PoolCall = async (method, params) => {
    calls?.push({ method, params });
    if (method === 'getBlocks') {
      const [from, to] = params as [number, number];
      return spec.blocks.filter((b) => b >= from && b <= to);
    }
    if (method === 'getSignaturesForAddress') {
      const [, opts] = params as [string, { minContextSlot?: number }];
      const slot = opts?.minContextSlot;
      if (slot === undefined) return [];
      const sigs = spec.sigsByBlock[slot] ?? [];
      return sigs.map((signature) => ({ signature, slot }));
    }
    if (method === 'getTransaction') {
      const [sig] = params as [string];
      return spec.tx(sig);
    }
    throw new Error(`unexpected method: ${method}`);
  };
  return { call: vi.fn(impl) } as unknown as RpcPool;
}
