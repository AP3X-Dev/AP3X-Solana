import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileVaultStorage } from './storage-file';
import type { AuditEntry, EncryptedRecord } from './types';

const isPosix = os.platform() !== 'win32';

function makeRecord(name: string): EncryptedRecord {
  return {
    version: 1,
    name,
    role: 'trader',
    address: 'So11111111111111111111111111111111111111112',
    kdf: {
      algo: 'argon2id',
      salt: 'c2FsdC1iYXNlNjQ=',
      opslimit: 1,
      memlimit: 1,
    },
    encryption: {
      algo: 'xsalsa20-poly1305',
      nonce: 'bm9uY2UtYmFzZTY0',
      ciphertext: 'Y2lwaGVydGV4dA==',
    },
    createdAt: '2026-04-19T00:00:00.000Z',
  };
}

describe('FileVaultStorage', () => {
  let baseDir: string;
  let storage: FileVaultStorage;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
    storage = new FileVaultStorage({ baseDir });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('read returns null for a missing wallet', async () => {
    expect(await storage.read('nope')).toBeNull();
  });

  it('write then read round-trips an EncryptedRecord verbatim', async () => {
    const rec = makeRecord('main');
    await storage.write('main', rec);
    const got = await storage.read('main');
    expect(got).toEqual(rec);
  });

  it('list returns wallet names sans .json suffix', async () => {
    await storage.write('alpha', makeRecord('alpha'));
    await storage.write('beta', makeRecord('beta'));
    const names = await storage.list();
    expect(new Set(names)).toEqual(new Set(['alpha', 'beta']));
  });

  it('list returns empty array when directory does not exist yet', async () => {
    // Fresh storage pointing at a directory we never write to.
    const nonexistent = path.join(baseDir, 'nested', 'deeper');
    const s = new FileVaultStorage({ baseDir: nonexistent });
    expect(await s.list()).toEqual([]);
  });

  it('appendAudit appends JSONL and readAudit parses it back', async () => {
    const e1: AuditEntry = {
      timestamp: '2026-04-19T00:00:00.000Z',
      event: 'create',
      metadata: { role: 'trader' },
    };
    const e2: AuditEntry = {
      timestamp: '2026-04-19T00:00:01.000Z',
      event: 'unlock',
    };
    await storage.appendAudit('main', e1);
    await storage.appendAudit('main', e2);
    const got = await storage.readAudit('main');
    expect(got).toEqual([e1, e2]);
  });

  it('readAudit returns empty array when the audit file is missing', async () => {
    expect(await storage.readAudit('main')).toEqual([]);
  });

  it('rejects wallet names with path traversal characters', async () => {
    await expect(storage.read('../etc/passwd')).rejects.toThrow(/invalid wallet name/);
    await expect(storage.write('a/b', makeRecord('a/b'))).rejects.toThrow(/invalid wallet name/);
    await expect(storage.appendAudit('..', { timestamp: 'x', event: 'create' })).rejects.toThrow(
      /invalid wallet name/,
    );
  });

  it('rejects wallet names with backslashes (Windows traversal)', async () => {
    await expect(storage.read('a\\b')).rejects.toThrow(/invalid wallet name/);
  });

  it('rejects wallet names with whitespace', async () => {
    await expect(storage.read('evil name')).rejects.toThrow(/invalid wallet name/);
  });

  it('rejects empty wallet names', async () => {
    await expect(storage.read('')).rejects.toThrow(/invalid wallet name/);
  });

  it.skipIf(!isPosix)('writes records with 0o600 file permissions on POSIX', async () => {
    await storage.write('perm', makeRecord('perm'));
    const stat = await fs.stat(path.join(baseDir, 'perm.json'));
    // Mask off non-perm bits to just the user/group/other rwx triplet.
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('write is atomic: leaves no .tmp file behind on success', async () => {
    await storage.write('atomic', makeRecord('atomic'));
    const entries = await fs.readdir(baseDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('uses the default baseDir when none is provided', () => {
    const s = new FileVaultStorage();
    expect(s.baseDir).toContain('.ap3x');
    expect(s.baseDir).toContain('vault');
  });

  it('readAudit skips blank lines (hardening against manual edits)', async () => {
    // Write raw content with a blank line in the middle.
    const p = path.join(baseDir, 'manual.audit.jsonl');
    await fs.writeFile(
      p,
      '{"timestamp":"t1","event":"create"}\n\n{"timestamp":"t2","event":"unlock"}\n',
      'utf-8',
    );
    const got = await storage.readAudit('manual');
    expect(got.length).toBe(2);
    expect(got[0]?.event).toBe('create');
    expect(got[1]?.event).toBe('unlock');
  });

  it('list ignores non-.json files', async () => {
    await storage.write('good', makeRecord('good'));
    // Create a stray unrelated file in the vault dir.
    await fs.writeFile(path.join(baseDir, 'README.txt'), 'hello', 'utf-8');
    const names = await storage.list();
    expect(names).toEqual(['good']);
  });
});
