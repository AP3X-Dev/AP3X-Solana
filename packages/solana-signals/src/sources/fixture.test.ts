import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { FixtureSignalSource } from './fixture.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sig-fix-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const writeFixture = async (file: string, lines: object[]): Promise<void> => {
  const gz = zlib.createGzip();
  const out = createWriteStream(file);
  gz.pipe(out);
  for (const l of lines) gz.write(JSON.stringify(l) + '\n');
  gz.end();
  await new Promise<void>((res) => out.on('close', () => res()));
};

describe('FixtureSignalSource', () => {
  it('replays gz-compressed jsonl signals', async () => {
    const file = path.join(dir, 'sig.jsonl.gz');
    await writeFixture(file, [
      { signalId: 'a', ts: 1, slot: 100, signature: 's1', programId: '11111111111111111111111111111111', kind: 'k', decoded: {}, raw: { programId: '11111111111111111111111111111111', accounts: [], logs: [], inner: [] } },
      { signalId: 'b', ts: 2, slot: 101, signature: 's2', programId: '11111111111111111111111111111111', kind: 'k', decoded: {}, raw: { programId: '11111111111111111111111111111111', accounts: [], logs: [], inner: [] } },
    ]);
    const src = new FixtureSignalSource({ path: file });
    const got: string[] = [];
    src.on('signal', (s) => got.push(s.signalId));
    await src.start();
    await new Promise((r) => src.on('end', () => r(undefined)));
    expect(got).toEqual(['a', 'b']);
  });

  it('honors AbortSignal mid-stream', async () => {
    const file = path.join(dir, 'big.jsonl.gz');
    const lines = Array.from({ length: 1000 }, (_, i) => ({
      signalId: `s${i}`, ts: i, slot: i, signature: `sig${i}`,
      programId: '11111111111111111111111111111111', kind: 'k', decoded: {},
      raw: { programId: '11111111111111111111111111111111', accounts: [], logs: [], inner: [] },
    }));
    await writeFixture(file, lines);
    const src = new FixtureSignalSource({ path: file });
    const ctrl = new AbortController();
    let count = 0;
    src.on('signal', () => {
      count++;
      if (count === 5) ctrl.abort();
    });
    await src.start(ctrl.signal);
    expect(count).toBeLessThan(1000);
  });
});
