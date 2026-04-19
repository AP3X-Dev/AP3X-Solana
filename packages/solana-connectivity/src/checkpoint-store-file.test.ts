import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Checkpoint } from './checkpoint-store';
import { FileCheckpointStore } from './checkpoint-store-file';

const isPosix = os.platform() !== 'win32';

function makeCheckpoint(lastSlot: number, updateCount = lastSlot * 2): Checkpoint {
  return {
    lastSlot,
    updateCount,
    timestamp: new Date(1_700_000_000_000 + lastSlot * 400).toISOString(),
  };
}

describe('FileCheckpointStore', () => {
  let baseDir: string;
  let store: FileCheckpointStore;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-test-'));
    store = new FileCheckpointStore({ baseDir });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Basic read/write
  // -------------------------------------------------------------------------

  it('load returns null for a missing key', async () => {
    expect(await store.load('never-written')).toBeNull();
  });

  it('save then load round-trips the Checkpoint verbatim', async () => {
    const ckpt = makeCheckpoint(12345);
    await store.save('helius-main', ckpt);
    const got = await store.load('helius-main');
    expect(got).toEqual(ckpt);
  });

  it('save overwrites the previous value for the same key', async () => {
    const first = makeCheckpoint(100);
    const second = makeCheckpoint(200);
    await store.save('endpoint', first);
    await store.save('endpoint', second);
    expect(await store.load('endpoint')).toEqual(second);
  });

  it('save creates the baseDir if it does not yet exist', async () => {
    const nested = path.join(baseDir, 'nested', 'deeper');
    const s = new FileCheckpointStore({ baseDir: nested });
    await s.save('created', makeCheckpoint(1));
    const got = await s.load('created');
    expect(got).toEqual(makeCheckpoint(1));
  });

  it('writes are atomic: no .tmp file left behind on success', async () => {
    await store.save('atomic', makeCheckpoint(42));
    const entries = await fs.readdir(baseDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
    expect(entries).toContain('atomic.json');
  });

  // -------------------------------------------------------------------------
  // Key validation / path-traversal whitelist
  // -------------------------------------------------------------------------

  it('rejects keys containing path traversal (.., slashes)', async () => {
    await expect(store.load('../etc/passwd')).rejects.toThrow(/invalid key/);
    await expect(store.save('a/b', makeCheckpoint(1))).rejects.toThrow(/invalid key/);
  });

  it('rejects empty keys', async () => {
    await expect(store.load('')).rejects.toThrow(/invalid key/);
    await expect(store.save('', makeCheckpoint(1))).rejects.toThrow(/invalid key/);
  });

  it('rejects keys with backslashes (Windows traversal)', async () => {
    await expect(store.load('a\\b')).rejects.toThrow(/invalid key/);
  });

  it('rejects keys with NUL bytes', async () => {
    await expect(store.load('a\0b')).rejects.toThrow(/invalid key/);
  });

  it('rejects keys with whitespace', async () => {
    await expect(store.load('has space')).rejects.toThrow(/invalid key/);
    await expect(store.load('tab\there')).rejects.toThrow(/invalid key/);
  });

  it('rejects dots-only keys (., ..) that pass the charset filter', async () => {
    await expect(store.load('.')).rejects.toThrow(/invalid key/);
    await expect(store.load('..')).rejects.toThrow(/invalid key/);
  });

  it('accepts safe keys with letters, digits, underscore, dash, dot', async () => {
    const key = 'helius_main-1.test';
    await store.save(key, makeCheckpoint(7));
    expect(await store.load(key)).toEqual(makeCheckpoint(7));
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  it('serializes 50 concurrent saves to the SAME key without corrupting the file', async () => {
    const N = 50;
    const ckpts = Array.from({ length: N }, (_, i) => makeCheckpoint(i + 1));
    await Promise.all(ckpts.map((c) => store.save('hot', c)));

    // After all saves settle, the file must be parseable JSON representing
    // one of the submitted checkpoints. Arrival-order serialization means
    // the LAST queued save wins — since Promise.all queues in array order,
    // that is `ckpts[N-1]`.
    const got = await store.load('hot');
    expect(got).not.toBeNull();
    expect(got).toEqual(ckpts[N - 1]);
  });

  it('concurrent saves on DIFFERENT keys all complete and each reads back its own value', async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `endpoint-${i}`);
    await Promise.all(
      keys.map((k, i) => store.save(k, makeCheckpoint(i * 10))),
    );
    const loaded = await Promise.all(keys.map((k) => store.load(k)));
    for (let i = 0; i < keys.length; i++) {
      expect(loaded[i]).toEqual(makeCheckpoint(i * 10));
    }
  });

  it('a save failure does not poison the per-key chain for subsequent saves', async () => {
    // Point the store at a baseDir we'll force to fail by pre-creating a FILE
    // where the store expects a DIRECTORY. mkdir will ENOTDIR on the first
    // save, but subsequent saves (after we remove the blocker) must work.
    const blockerDir = path.join(baseDir, 'blocked');
    await fs.writeFile(blockerDir, 'not-a-dir', 'utf-8');
    const s = new FileCheckpointStore({ baseDir: blockerDir });

    await expect(s.save('k', makeCheckpoint(1))).rejects.toThrow();
    // Unblock: replace the file with a real dir, then save again.
    await fs.rm(blockerDir);
    await expect(s.save('k', makeCheckpoint(2))).resolves.toBeUndefined();
    expect(await s.load('k')).toEqual(makeCheckpoint(2));
  });

  // -------------------------------------------------------------------------
  // File layout + permissions
  // -------------------------------------------------------------------------

  it('writes the checkpoint to <baseDir>/<key>.json', async () => {
    await store.save('layout', makeCheckpoint(9));
    const raw = await fs.readFile(path.join(baseDir, 'layout.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual(makeCheckpoint(9));
  });

  it.skipIf(!isPosix)('writes files with 0o600 mode on POSIX', async () => {
    await store.save('perm', makeCheckpoint(3));
    const stat = await fs.stat(path.join(baseDir, 'perm.json'));
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('load surfaces non-ENOENT errors (e.g. invalid JSON on disk)', async () => {
    // Plant a corrupt file under a safe key.
    await fs.writeFile(path.join(baseDir, 'corrupt.json'), '{not json', 'utf-8');
    await expect(store.load('corrupt')).rejects.toThrow();
  });

  it('exposes baseDir as a readonly property', () => {
    expect(store.baseDir).toBe(baseDir);
  });
});
