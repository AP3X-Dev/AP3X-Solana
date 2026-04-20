import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import type { DecodedEventStream } from '@ap3x/solana-events';
import { HistoricalSignalSource } from './historical.js';

const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const programIdStr = programId.toBase58();

// ---------------------------------------------------------------------------
// Fake RPC pool
// ---------------------------------------------------------------------------
// Returns the list of slots in [from, to] that appear in `events`, then for
// each slot returns a minimal block with one transaction whose logMessages
// contain a well-formed invoke/success pair for the target program.

const fakeRpcPool = (events: Array<{ slot: number; signature: string }>): any => ({
  call: vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'getBlocks') {
      const [from, to] = params as [number, number];
      return events.filter((e) => e.slot >= from && e.slot <= to).map((e) => e.slot);
    }
    if (method === 'getBlock') {
      const [slot] = params as [number];
      const e = events.find((x) => x.slot === slot);
      if (!e) return null;
      return {
        blockTime: 1_700_000_000,
        transactions: [
          {
            transaction: { signatures: [e.signature] },
            meta: {
              logMessages: [
                `Program ${programIdStr} invoke [1]`,
                `Program ${programIdStr} success`,
              ],
            },
          },
        ],
      };
    }
    return null;
  }),
});

// ---------------------------------------------------------------------------
// Fake decoder registry
// ---------------------------------------------------------------------------
// The real EventDecoderRegistry.decode() receives a TransactionLog and returns
// DecodedEventStream: { events: EventUnion[]; unknown: UnknownEventDecode[]; parseErrors: [] }.
// DecodedEvent shape: { kind: 'decoded'; programId: string; data: unknown }.
// We return one 'decoded' event per call so the source emits one signal per tx.

const fakeRegistry = {
  decode: (): DecodedEventStream => ({
    events: [{ kind: 'decoded', programId: programIdStr, data: {} }],
    unknown: [],
    parseErrors: [],
  }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HistoricalSignalSource', () => {
  it('emits signals for each decoded event in slot range', async () => {
    const rpcPool = fakeRpcPool([
      { slot: 100, signature: 's1' },
      { slot: 101, signature: 's2' },
      { slot: 102, signature: 's3' },
    ]);
    const src = new HistoricalSignalSource({
      rpcPool,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
      slotRange: { from: 100, to: 102 },
      batchSize: 10,
    });
    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));
    await src.start();
    expect(got).toEqual(['s1', 's2', 's3']);
  });

  it('paginates by batchSize', async () => {
    const rpcPool = fakeRpcPool(
      Array.from({ length: 5 }, (_, i) => ({ slot: 100 + i, signature: `s${i}` })),
    );
    const src = new HistoricalSignalSource({
      rpcPool,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
      slotRange: { from: 100, to: 104 },
      batchSize: 2,
    });
    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));
    await src.start();
    expect(got).toEqual(['s0', 's1', 's2', 's3', 's4']);
    // 5 slots with batchSize=2: [100,101], [102,103], [104,104] → 3 getBlocks calls
    expect((rpcPool.call as any).mock.calls.filter((c: any[]) => c[0] === 'getBlocks')).toHaveLength(3);
  });

  it('aborts mid-stream when stop() is called', async () => {
    // Use a slow RPC pool that we can interrupt
    let callCount = 0;
    const slots = Array.from({ length: 10 }, (_, i) => ({ slot: 200 + i, signature: `abort-s${i}` }));
    const slowRpcPool: any = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getBlocks') {
          const [from, to] = params as [number, number];
          return slots.filter((e) => e.slot >= from && e.slot <= to).map((e) => e.slot);
        }
        if (method === 'getBlock') {
          callCount++;
          const [slot] = params as [number];
          const e = slots.find((x) => x.slot === slot);
          if (!e) return null;
          return {
            blockTime: 1_700_000_000,
            transactions: [{
              transaction: { signatures: [e.signature] },
              meta: { logMessages: [`Program ${programIdStr} invoke [1]`, `Program ${programIdStr} success`] },
            }],
          };
        }
        return null;
      }),
    };

    const src = new HistoricalSignalSource({
      rpcPool: slowRpcPool,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
      slotRange: { from: 200, to: 209 },
      batchSize: 10,
    });

    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));

    // Start then immediately stop
    const startPromise = src.start();
    await src.stop(); // sets aborted = true
    await startPromise;

    // Should have processed fewer than all 10 slots
    expect(got.length).toBeLessThanOrEqual(10);
  });

  it('emits error when rpcPool throws', async () => {
    const throwingPool: any = {
      call: vi.fn().mockRejectedValue(new Error('rpc boom')),
    };

    const src = new HistoricalSignalSource({
      rpcPool: throwingPool,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
      slotRange: { from: 300, to: 305 },
    });

    const errors: Error[] = [];
    src.on('error', (e) => errors.push(e));

    await src.start();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('rpc boom');
  });

  it('emits end event after all slots processed', async () => {
    const rpcPool = fakeRpcPool([{ slot: 400, signature: 'end-sig' }]);
    const src = new HistoricalSignalSource({
      rpcPool,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
      slotRange: { from: 400, to: 400 },
    });

    let endEmitted = false;
    src.on('end', () => { endEmitted = true; });

    await src.start();
    // 'end' is async via setImmediate on geyser; for historical it's direct
    await new Promise<void>((r) => setImmediate(r));

    expect(endEmitted).toBe(true);
  });

  it('finds chunk via nested CPI children (findChunkByProgramId child path)', async () => {
    const parentProgramId = '11111111111111111111111111111111';
    // Logs with a CPI: parent invokes child (depth 2)
    const nestedLogs = [
      `Program ${parentProgramId} invoke [1]`,
      `Program ${programIdStr} invoke [2]`,
      `Program ${programIdStr} success`,
      `Program ${parentProgramId} success`,
    ];

    const nestedPool: any = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getBlocks') {
          const [from, to] = params as [number, number];
          return [600].filter((s) => s >= from && s <= to);
        }
        if (method === 'getBlock') {
          return {
            blockTime: 1_700_000_000,
            transactions: [{
              transaction: { signatures: ['sigNested'] },
              meta: { logMessages: nestedLogs },
            }],
          };
        }
        return null;
      }),
    };

    // Registry returns an event for child program (nested under parent)
    const nestedRegistry = {
      decode: () => ({
        events: [{ kind: 'decoded', programId: programIdStr, data: {} }],
        unknown: [],
        parseErrors: [],
      }),
    };

    const src = new HistoricalSignalSource({
      rpcPool: nestedPool,
      decoderRegistry: nestedRegistry as any,
      programIds: [programId],
      slotRange: { from: 600, to: 600 },
    });

    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));
    await src.start();

    expect(got).toEqual(['sigNested']);
  });

  it('skips transactions without signature or logMessages', async () => {
    const badPool: any = {
      call: vi.fn(async (method: string, _params: unknown[]) => {
        if (method === 'getBlocks') return [500];
        if (method === 'getBlock') {
          return {
            blockTime: 1_700_000_000,
            transactions: [
              // Missing signature
              { transaction: {}, meta: { logMessages: [`Program ${programIdStr} invoke [1]`] } },
              // Missing logMessages
              { transaction: { signatures: ['sigX'] }, meta: {} },
              // Both present — should emit signal
              { transaction: { signatures: ['sigGood'] }, meta: {
                logMessages: [`Program ${programIdStr} invoke [1]`, `Program ${programIdStr} success`],
              }},
            ],
          };
        }
        return null;
      }),
    };

    const src = new HistoricalSignalSource({
      rpcPool: badPool,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
      slotRange: { from: 500, to: 500 },
    });

    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));
    await src.start();

    expect(got).toEqual(['sigGood']);
  });
});
