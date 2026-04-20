import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PublicKey } from '@ap3x/solana-core';
import { GeyserSignalSource } from './geyser.js';

const programId = PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

class FakeGeyserClient extends EventEmitter {
  subscribe = vi.fn((_req, handler) => {
    setTimeout(() => {
      handler({
        slot: 100,
        signature: 'sigA',
        logs: [`Program ${programId.toBase58()} invoke [1]`, `Program ${programId.toBase58()} success`],
      });
    }, 10);
    return { unsubscribe: () => {} };
  });
}

const fakeRegistry = {
  decode: () => ({ events: [{ kind: 'decoded', programId: programId.toBase58(), data: { kind: 'spl.transfer' } }], unknown: [], parseErrors: [] }),
};

describe('GeyserSignalSource', () => {
  it('emits Signal per decoded event from Geyser stream', async () => {
    const client = new FakeGeyserClient();
    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });
    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));
    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual(['sigA']);
    await src.stop();
  });

  it('emits gap event when slot skips ahead', async () => {
    const client = new FakeGeyserClient();
    // Override to deliver two updates with a slot gap.
    client.subscribe = vi.fn((_req, handler) => {
      setTimeout(() => {
        handler({
          slot: 100,
          signature: 'sigA',
          logs: [`Program ${programId.toBase58()} invoke [1]`, `Program ${programId.toBase58()} success`],
        });
        setTimeout(() => {
          handler({
            slot: 103, // skips 101+102
            signature: 'sigB',
            logs: [`Program ${programId.toBase58()} invoke [1]`, `Program ${programId.toBase58()} success`],
          });
        }, 5);
      }, 10);
      return { unsubscribe: () => {} };
    });

    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });

    const signals: string[] = [];
    const gaps: Array<{ fromSlot: number; toSlot: number }> = [];
    src.on('signal', (s) => signals.push(s.signature));
    src.on('gap', (g) => gaps.push({ fromSlot: g.fromSlot, toSlot: g.toSlot }));

    await src.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(signals).toEqual(['sigA', 'sigB']);
    expect(gaps).toEqual([{ fromSlot: 101, toSlot: 102 }]);
    await src.stop();
  });

  it('does not emit gap on the very first update', async () => {
    const client = new FakeGeyserClient();
    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });

    const gaps: unknown[] = [];
    src.on('gap', (g) => gaps.push(g));

    await src.start();
    await new Promise((r) => setTimeout(r, 30));

    expect(gaps).toHaveLength(0);
    await src.stop();
  });

  it('stop() is safe to call multiple times', async () => {
    const client = new FakeGeyserClient();
    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });
    await src.start();
    await src.stop();
    await expect(src.stop()).resolves.toBeUndefined();
  });

  it('emits error event when handler throws', async () => {
    const client = new FakeGeyserClient();
    client.subscribe = vi.fn((_req, handler) => {
      setTimeout(() => {
        // Pass a malformed update that will cause extractTxUpdate to return undefined,
        // then throw inside the try block by having decoder throw
        handler({ slot: 200, signature: 'sigErr', logs: [] });
      }, 10);
      return { unsubscribe: () => {} };
    });

    const throwingRegistry = {
      decode: () => { throw new Error('decoder boom'); },
    };

    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: throwingRegistry as any,
      programIds: [programId],
    });

    const errors: Error[] = [];
    src.on('error', (e) => errors.push(e));

    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    await src.stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('decoder boom');
  });

  it('ignores updates whose programId is not in filter', async () => {
    const otherProgramId = PublicKey.fromBase58('11111111111111111111111111111111');
    const client = new FakeGeyserClient();
    client.subscribe = vi.fn((_req, handler) => {
      setTimeout(() => {
        handler({
          slot: 300,
          signature: 'sigFilter',
          logs: [`Program ${programId.toBase58()} invoke [1]`, `Program ${programId.toBase58()} success`],
        });
      }, 10);
      return { unsubscribe: () => {} };
    });

    // Registry returns events for a different programId — should be filtered out
    const filteredRegistry = {
      decode: () => ({
        events: [{ kind: 'decoded', programId: otherProgramId.toBase58(), data: {} }],
        unknown: [],
        parseErrors: [],
      }),
    };

    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: filteredRegistry as any,
      programIds: [programId], // only filtering for programId, not otherProgramId
    });

    const signals: unknown[] = [];
    src.on('signal', (s) => signals.push(s));

    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    await src.stop();

    expect(signals).toHaveLength(0);
  });

  it('handles live Geyser proto-shaped update (txEnvelope path)', async () => {
    const client = new FakeGeyserClient();
    const protoUpdate = {
      // Live proto shape: top-level 'transaction' envelope
      transaction: {
        slot: '400',
        transaction: {
          signatures: ['sigProto'],
        },
        meta: {
          logMessages: [
            `Program ${programId.toBase58()} invoke [1]`,
            `Program ${programId.toBase58()} success`,
          ],
        },
      },
    };

    client.subscribe = vi.fn((_req, handler) => {
      setTimeout(() => { handler(protoUpdate as any); }, 10);
      return { unsubscribe: () => {} };
    });

    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });

    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signature));

    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    await src.stop();

    expect(got).toEqual(['sigProto']);
  });

  it('discards proto update with missing txEnvelope', async () => {
    const client = new FakeGeyserClient();
    client.subscribe = vi.fn((_req, handler) => {
      setTimeout(() => {
        // No 'slot' at top level, no 'transaction' envelope — extractTxUpdate returns undefined
        handler({ ping: true } as any);
      }, 10);
      return { unsubscribe: () => {} };
    });

    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });

    const signals: unknown[] = [];
    src.on('signal', (s) => signals.push(s));

    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    await src.stop();

    expect(signals).toHaveLength(0);
  });

  it('discards proto update with non-finite slot', async () => {
    const client = new FakeGeyserClient();
    client.subscribe = vi.fn((_req, handler) => {
      setTimeout(() => {
        handler({
          transaction: {
            slot: 'not-a-number',
            transaction: { signatures: ['sigBad'] },
            meta: { logMessages: [] },
          },
        } as any);
      }, 10);
      return { unsubscribe: () => {} };
    });

    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });

    const signals: unknown[] = [];
    src.on('signal', (s) => signals.push(s));

    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    await src.stop();

    expect(signals).toHaveLength(0);
  });

  it('finds chunk via nested CPI children (findChunkByProgramId child path)', async () => {
    const parentProgramId = PublicKey.fromBase58('11111111111111111111111111111111');
    const childProgramId = programId; // TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA

    const client = new FakeGeyserClient();
    client.subscribe = vi.fn((_req, handler) => {
      setTimeout(() => {
        handler({
          slot: 600,
          signature: 'sigNested',
          // Logs with a CPI: parent invokes child (depth 2)
          logs: [
            `Program ${parentProgramId.toBase58()} invoke [1]`,
            `Program ${childProgramId.toBase58()} invoke [2]`,
            `Program ${childProgramId.toBase58()} success`,
            `Program ${parentProgramId.toBase58()} success`,
          ],
        });
      }, 10);
      return { unsubscribe: () => {} };
    });

    // Registry returns an event for the child program (nested under parent)
    const nestedRegistry = {
      decode: () => ({
        events: [{ kind: 'decoded', programId: childProgramId.toBase58(), data: {} }],
        unknown: [],
        parseErrors: [],
      }),
    };

    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: nestedRegistry as any,
      programIds: [childProgramId],
    });

    const signals: string[] = [];
    src.on('signal', (s) => signals.push(s.signature));

    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    await src.stop();

    // Signal should be emitted; raw chunk is found via child traversal
    expect(signals).toEqual(['sigNested']);
  });

  it('discards proto update with no signature', async () => {
    const client = new FakeGeyserClient();
    client.subscribe = vi.fn((_req, handler) => {
      setTimeout(() => {
        handler({
          transaction: {
            slot: '500',
            transaction: { signatures: [] }, // empty → no signature
            meta: { logMessages: [] },
          },
        } as any);
      }, 10);
      return { unsubscribe: () => {} };
    });

    const src = new GeyserSignalSource({
      geyserClient: client as any,
      decoderRegistry: fakeRegistry as any,
      programIds: [programId],
    });

    const signals: unknown[] = [];
    src.on('signal', (s) => signals.push(s));

    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    await src.stop();

    expect(signals).toHaveLength(0);
  });
});
