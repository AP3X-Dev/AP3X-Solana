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
});
