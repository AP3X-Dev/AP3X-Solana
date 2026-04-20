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
});
