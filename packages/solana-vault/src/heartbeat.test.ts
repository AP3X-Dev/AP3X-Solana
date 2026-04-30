import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultHeartbeat, readHeartbeatFile } from './heartbeat';

function tmpPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-heartbeat-'));
  return join(dir, name);
}

describe('VaultHeartbeat', () => {
  it('starts with a null snapshot when no startedAt is supplied', () => {
    const hb = new VaultHeartbeat({ now: () => 1000 });
    expect(hb.snapshot()).toEqual({ lastWriteAt: null, ageMs: null });
  });

  it('honors startedAt as the seed timestamp', () => {
    const hb = new VaultHeartbeat({ now: () => 1000, startedAt: 500 });
    expect(hb.snapshot()).toEqual({ lastWriteAt: 500, ageMs: 500 });
  });

  it('tick() updates the in-memory snapshot', () => {
    let now = 1000;
    const hb = new VaultHeartbeat({ now: () => now });
    hb.tick();
    now = 2500;
    expect(hb.snapshot()).toEqual({ lastWriteAt: 1000, ageMs: 1500 });
  });

  it('tick(at) accepts an explicit timestamp', () => {
    const hb = new VaultHeartbeat({ now: () => 9999 });
    hb.tick(42);
    expect(hb.snapshot()).toEqual({ lastWriteAt: 42, ageMs: 9999 - 42 });
  });

  it('persists to disk via temp-file rename so external readers see one or the other', () => {
    const path = tmpPath('hb.json');
    const hb = new VaultHeartbeat({ path, now: () => 5000 });
    hb.tick();
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.lastWriteAt).toBe(5000);
    expect(parsed.iso).toBe(new Date(5000).toISOString());
  });

  it('readHeartbeatFile round-trips through tick()', () => {
    const path = tmpPath('hb.json');
    const hb = new VaultHeartbeat({ path, now: () => 7777 });
    hb.tick();
    const persisted = readHeartbeatFile(path);
    expect(persisted).toEqual({ lastWriteAt: 7777, iso: new Date(7777).toISOString() });
  });

  it('readHeartbeatFile returns null when the file is missing', () => {
    const path = tmpPath('absent.json');
    expect(readHeartbeatFile(path)).toBeNull();
  });

  it('readHeartbeatFile throws on a corrupt heartbeat file', () => {
    const path = tmpPath('bad.json');
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(path, '{"unrelated":"shape"}', 'utf8');
    expect(() => readHeartbeatFile(path)).toThrow(/not a valid heartbeat/);
  });
});
