/**
 * `FileVaultStorage` — the default `VaultStorage` implementation.
 *
 * Lays out records under `baseDir` (default `~/.ap3x/vault/`) as:
 *   <name>.json        — encrypted record (see EncryptedRecord)
 *   <name>.audit.jsonl — newline-delimited AuditEntry log
 *
 * Writes are atomic (tmp + rename) to prevent partial records on crash, and
 * file permissions are set to 0o600 so only the owning user can read them
 * (ignored on Windows). Wallet names are restricted to a conservative charset
 * so that a compromised caller can't traverse out of the vault directory via
 * `..` or OS-specific path separators.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AuditEntry, EncryptedRecord, VaultStorage } from './types';

/**
 * Allowed characters for wallet names. Intentionally conservative:
 *  - letters, digits, underscore, dash, dot
 *  - no slash / backslash (path traversal)
 *  - no whitespace (shell quoting hazards)
 *  - non-empty
 */
const SAFE_NAME = /^[a-zA-Z0-9_.-]+$/;

export interface FileVaultStorageOptions {
  /** Directory to store vault records. Defaults to `~/.ap3x/vault/`. */
  baseDir?: string;
}

export class FileVaultStorage implements VaultStorage {
  readonly baseDir: string;

  /**
   * Serialization chain for `appendAudit`. `fs.appendFile` in Node is not
   * guaranteed line-atomic across concurrent writers — on Windows especially,
   * two overlapping appends can interleave bytes and corrupt the JSONL log.
   * Chaining each append onto the previous promise keeps writes strictly
   * sequential within one storage instance. Across instances (unlikely: we
   * expect one `FileVaultStorage` per Vault) this does not help.
   */
  #auditChain: Promise<void> = Promise.resolve();

  constructor(options: FileVaultStorageOptions = {}) {
    this.baseDir = options.baseDir ?? path.join(os.homedir(), '.ap3x', 'vault');
  }

  private sanitize(name: string): string {
    if (!SAFE_NAME.test(name)) {
      throw new Error(
        `vault: invalid wallet name '${name}' (allowed: a-z A-Z 0-9 _ . -)`,
      );
    }
    // `.` and `..` pass the charset filter but are still path-traversal hazards.
    // Reject any name composed purely of dots.
    if (/^\.+$/.test(name)) {
      throw new Error(`vault: invalid wallet name '${name}' (dots only)`);
    }
    return name;
  }

  private recordPath(name: string): string {
    return path.join(this.baseDir, `${this.sanitize(name)}.json`);
  }

  private auditPath(name: string): string {
    return path.join(this.baseDir, `${this.sanitize(name)}.audit.jsonl`);
  }

  async read(name: string): Promise<EncryptedRecord | null> {
    try {
      const content = await fs.readFile(this.recordPath(name), 'utf-8');
      return JSON.parse(content) as EncryptedRecord;
    } catch (e: unknown) {
      if (isNodeError(e) && e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async write(name: string, rec: EncryptedRecord): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    // Atomic replace: write to tmp, then rename. On POSIX rename is atomic
    // within the same filesystem; on Windows the semantics are slightly
    // weaker but good enough to avoid torn writes for a single-writer vault.
    const final = this.recordPath(name);
    const tmp = `${final}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(tmp, final);
    // `writeFile` sets the mode on create; after a rename we re-chmod in case
    // a previous file had laxer perms. Ignore on platforms that reject chmod.
    try {
      await fs.chmod(final, 0o600);
    } catch {
      /* best effort — Windows + some mounted FS reject chmod */
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir);
      return entries
        .filter((e) => e.endsWith('.json') && !e.endsWith('.tmp'))
        .map((e) => e.slice(0, -'.json'.length));
    } catch (e: unknown) {
      if (isNodeError(e) && e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async appendAudit(name: string, entry: AuditEntry): Promise<void> {
    // Sanitize synchronously so invalid names throw to the caller immediately
    // instead of silently swallowing the rejection into `#auditChain`.
    const auditPath = this.auditPath(name);
    const next = this.#auditChain.then(() =>
      this.#doAppendAudit(auditPath, entry),
    );
    // Keep the chain alive even after a failed write — otherwise one I/O
    // error would permanently poison future appends on this instance.
    this.#auditChain = next.catch(() => {
      /* swallow to keep chain alive */
    });
    return next;
  }

  async #doAppendAudit(auditPath: string, entry: AuditEntry): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    // Each line is a complete JSON object so a torn write can at worst lose
    // the tail line, never corrupt earlier entries.
    const line = `${JSON.stringify(entry)}\n`;
    await fs.appendFile(auditPath, line, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  async readAudit(name: string): Promise<AuditEntry[]> {
    try {
      const content = await fs.readFile(this.auditPath(name), 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch (e: unknown) {
      if (isNodeError(e) && e.code === 'ENOENT') return [];
      throw e;
    }
  }
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e;
}
