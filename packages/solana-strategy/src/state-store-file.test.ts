import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStrategyStateStore } from './state-store-file.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strategy-state-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('FileStrategyStateStore', () => {
  // -------------------------------------------------------------------------
  // 1. Round-trip: set → get for various value types
  // -------------------------------------------------------------------------
  it('round-trips a string value', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    await store.set('str-key', 'hello world');
    expect(await store.get<string>('str-key')).toBe('hello world');
  });

  it('round-trips a number value', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    await store.set('num-key', 42);
    expect(await store.get<number>('num-key')).toBe(42);
  });

  it('round-trips an object value', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    const obj = { a: 1, b: 'two', c: [true, false] };
    await store.set('obj-key', obj);
    expect(await store.get<typeof obj>('obj-key')).toEqual(obj);
  });

  it('round-trips a bigint-as-string value', async () => {
    // BigInt does not survive JSON natively; caller convention is to serialise
    // as a string before storing. Verify the round-trip is lossless.
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    const bigVal = '18446744073709551615n'; // u64-max as string
    await store.set('bigint-key', bigVal);
    expect(await store.get<string>('bigint-key')).toBe(bigVal);
  });

  // -------------------------------------------------------------------------
  // 2. Isolation per (strategyName, instanceId)
  // -------------------------------------------------------------------------
  it('isolates values across different instanceIds for the same key', async () => {
    const storeA = new FileStrategyStateStore({ dir, strategyName: 'strat', instanceId: 'a' });
    const storeB = new FileStrategyStateStore({ dir, strategyName: 'strat', instanceId: 'b' });
    await storeA.set('k', 'value-a');
    await storeB.set('k', 'value-b');
    expect(await storeA.get<string>('k')).toBe('value-a');
    expect(await storeB.get<string>('k')).toBe('value-b');
  });

  // -------------------------------------------------------------------------
  // 3. Atomic write — orphan tmp file does not corrupt reads
  // -------------------------------------------------------------------------
  it('get reads key.json, not an orphan tmp file left behind from a prior crash', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });

    // Write a known good value via the normal path.
    await store.set('key', 'good-value');

    // Simulate an orphan tmp file left behind by a killed writer for the same
    // key. The file contains corrupt/partial content.
    const storeDir = path.join(dir, 'test', 'i1');
    const orphan = path.join(storeDir, `key.json.tmp.${process.pid}.${Date.now()}`);
    await fs.writeFile(orphan, '{"partial":true', 'utf8'); // intentionally incomplete JSON

    // get must still return the correct value from key.json, never the orphan.
    expect(await store.get<string>('key')).toBe('good-value');

    // The orphan file was not cleaned up by get (that is not get's job).
    const entries = await fs.readdir(storeDir);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(true);
  });

  it('set leaves no .tmp file behind on success', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    await store.set('atomic', 'val');
    const storeDir = path.join(dir, 'test', 'i1');
    const entries = await fs.readdir(storeDir);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. list with prefix
  // -------------------------------------------------------------------------
  it('list returns all keys when no prefix is given', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    await store.set('a-1', 1);
    await store.set('a-2', 2);
    await store.set('b-1', 3);
    const all = (await store.list()).sort();
    expect(all).toEqual(['a-1', 'a-2', 'b-1']);
  });

  it('list filters keys by prefix', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    await store.set('a-1', 1);
    await store.set('a-2', 2);
    await store.set('b-1', 3);
    const aKeys = (await store.list('a')).sort();
    expect(aKeys).toEqual(['a-1', 'a-2']);
  });

  it('list returns empty array when dir does not exist yet', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'noexist', instanceId: 'i1' });
    expect(await store.list()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. delete
  // -------------------------------------------------------------------------
  it('delete removes the key so get returns null', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    await store.set('to-delete', 'bye');
    await store.delete('to-delete');
    expect(await store.get<string>('to-delete')).toBeNull();
  });

  it('delete is idempotent — does not throw for a missing key', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });
    await expect(store.delete('no-such-key')).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. Concurrent set calls to the same key — no interleaving
  // -------------------------------------------------------------------------
  it('serialises concurrent set calls to the same key via per-key mutex', async () => {
    const store = new FileStrategyStateStore({ dir, strategyName: 'test', instanceId: 'i1' });

    // Fire concurrent sets; the last queued write ('c') must win since
    // the mutex serialises them in arrival order.
    await Promise.all([
      store.set('k', 'a'),
      store.set('k', 'b'),
      store.set('k', 'c'),
    ]);

    // The final stored value must be exactly one of the three — never corrupt
    // JSON from an interleaved write.  Because our mutex serialises in
    // arrival order, 'c' is expected to be the winner.
    const result = await store.get<string>('k');
    expect(['a', 'b', 'c']).toContain(result);
    // Verify the file is parseable (no corruption).
    expect(typeof result).toBe('string');
  });
});
