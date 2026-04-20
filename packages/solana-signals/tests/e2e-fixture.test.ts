import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {
  FixtureSignalSource,
  SignalQueue,
  FileSignalCheckpointStore,
} from '@ap3x/solana-signals';
import type { Signal } from '@ap3x/solana-signals';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-e2e-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('signals E2E', () => {
  it('fixture → queue → subscriber → checkpoint', async () => {
    const fixturePath = path.join(dir, 'sig.jsonl.gz');
    const lines = Array.from({ length: 50 }, (_, i) => ({
      signalId: `id${i}`, ts: i, slot: 100 + i, signature: `sig${i}`,
      programId: '11111111111111111111111111111111', kind: 'test', decoded: {},
      raw: { programId: '11111111111111111111111111111111', accounts: [], logs: [], inner: [] },
    }));
    const gz = zlib.createGzip();
    const out = createWriteStream(fixturePath);
    gz.pipe(out);
    for (const l of lines) gz.write(JSON.stringify(l) + '\n');
    gz.end();
    await new Promise<void>((res) => out.on('close', () => res()));

    const src = new FixtureSignalSource({ path: fixturePath });
    const queue = new SignalQueue({ capacity: 100 });
    const ckpt = new FileSignalCheckpointStore({ dir: path.join(dir, 'ckpt') });
    const seen: string[] = [];

    // Collect save promises so we can await all of them after drain().
    // This is necessary because SignalQueue.dispatch() fires the last
    // handler via a void-dispatch triggered inside push(), meaning drain()
    // can exit (buffer empty) while that handler's async ckpt.save() is
    // still in-flight. Awaiting savePromises ensures all writes complete
    // before we assert the checkpoint.
    const savePromises: Promise<void>[] = [];

    queue.subscribe('test-sub', (sig) => {
      seen.push(sig.signalId);
      const p = ckpt.save('test-sub', { lastSignalId: sig.signalId, lastSlot: sig.slot });
      savePromises.push(p);
      return p;
    });

    // Collect all signals emitted during replay so we can push them
    // sequentially (await each push) rather than fire-and-forget.
    // The 'signal' event fires synchronously inside the readline loop;
    // queue.push() is async and safe to defer.
    const collected: Signal[] = [];
    src.on('signal', (s: Signal) => { collected.push(s); });

    await src.start();
    await new Promise((r) => src.on('end', () => r(undefined)));

    for (const s of collected) {
      await queue.push(s);
    }
    await queue.drain();
    // Wait for any save promises still completing after drain exits.
    await Promise.all(savePromises);

    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50); // no dupes
    expect(await ckpt.load('test-sub')).toEqual({ lastSignalId: 'id49', lastSlot: 149 });
  });
});
