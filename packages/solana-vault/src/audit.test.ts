import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logAudit, readAudit } from './audit';
import { FileVaultStorage } from './storage-file';

describe('audit helpers — logAudit / readAudit', () => {
  let baseDir: string;
  let storage: FileVaultStorage;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-audit-'));
    storage = new FileVaultStorage({ baseDir });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('logAudit appends an entry with an ISO-8601 timestamp', async () => {
    await logAudit(storage, 'main', 'create', { role: 'trader' });
    const entries = await readAudit(storage, 'main');
    expect(entries.length).toBe(1);
    expect(entries[0]?.event).toBe('create');
    expect(entries[0]?.metadata).toEqual({ role: 'trader' });
    // ISO timestamp matches the YYYY-MM-DDTHH:MM:SS.sssZ shape.
    expect(entries[0]?.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('logAudit works without metadata (optional param)', async () => {
    await logAudit(storage, 'main', 'unlock');
    const entries = await readAudit(storage, 'main');
    expect(entries.length).toBe(1);
    expect(entries[0]?.event).toBe('unlock');
    expect(entries[0]?.metadata).toBeUndefined();
  });

  it('readAudit returns entries in write order', async () => {
    // Write distinct events one-by-one. readAudit must preserve append order.
    await logAudit(storage, 'main', 'create', { seq: 1 });
    await logAudit(storage, 'main', 'unlock', { seq: 2 });
    await logAudit(storage, 'main', 'sign', { seq: 3 });
    await logAudit(storage, 'main', 'rotate', { seq: 4 });
    const entries = await readAudit(storage, 'main');
    expect(entries.map((e) => e.event)).toEqual([
      'create',
      'unlock',
      'sign',
      'rotate',
    ]);
    expect(entries.map((e) => e.metadata?.seq)).toEqual([1, 2, 3, 4]);
  });

  it('readAudit returns empty array for an unknown wallet', async () => {
    expect(await readAudit(storage, 'ghost')).toEqual([]);
  });

  it('logAudit supports all four event kinds (create | unlock | sign | rotate)', async () => {
    await logAudit(storage, 'full', 'create');
    await logAudit(storage, 'full', 'unlock');
    await logAudit(storage, 'full', 'sign');
    await logAudit(storage, 'full', 'rotate');
    const events = (await readAudit(storage, 'full')).map((e) => e.event);
    expect(events).toEqual(['create', 'unlock', 'sign', 'rotate']);
  });
});
