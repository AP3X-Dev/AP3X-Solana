import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileSignalCheckpointStore } from './checkpoint-store.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-ckpt-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('FileSignalCheckpointStore', () => {
  it('returns null for missing checkpoint', async () => {
    const store = new FileSignalCheckpointStore({ dir });
    expect(await store.load('sub1')).toBeNull();
  });

  it('round-trips save → load', async () => {
    const store = new FileSignalCheckpointStore({ dir });
    await store.save('sub1', { lastSignalId: 'abc', lastSlot: 42 });
    expect(await store.load('sub1')).toEqual({ lastSignalId: 'abc', lastSlot: 42 });
  });

  it('isolates per-subscriber files', async () => {
    const store = new FileSignalCheckpointStore({ dir });
    await store.save('a', { lastSignalId: '1', lastSlot: 1 });
    await store.save('b', { lastSignalId: '2', lastSlot: 2 });
    expect(await store.load('a')).toEqual({ lastSignalId: '1', lastSlot: 1 });
    expect(await store.load('b')).toEqual({ lastSignalId: '2', lastSlot: 2 });
  });

  it('survives concurrent saves to the same subscriber via mutex', async () => {
    const store = new FileSignalCheckpointStore({ dir });
    await Promise.all([
      store.save('sub', { lastSignalId: 'a', lastSlot: 1 }),
      store.save('sub', { lastSignalId: 'b', lastSlot: 2 }),
      store.save('sub', { lastSignalId: 'c', lastSlot: 3 }),
    ]);
    const result = await store.load('sub');
    expect(['a', 'b', 'c']).toContain(result!.lastSignalId);
  });
});
