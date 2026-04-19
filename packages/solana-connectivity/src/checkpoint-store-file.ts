/**
 * `FileCheckpointStore` — file-backed `CheckpointStore` for Geyser subscribers.
 *
 * Layout: `<baseDir>/<key>.json` — one file per checkpoint key. The file is
 * a plain JSON-serialized `Checkpoint`. A sibling `<key>.json.tmp` may appear
 * briefly during a write but is renamed into place atomically on success.
 *
 * Durability / crash-safety:
 *  - Writes go to a `.tmp` file first and are atomically renamed. On POSIX,
 *    rename within the same filesystem is atomic; on Windows the semantics
 *    are slightly weaker but still avoid the "half-written JSON" failure mode
 *    that would break `load()` on the next start.
 *  - Files are created with mode `0o600` on POSIX so checkpoints are not
 *    world-readable. Windows ignores the mode and uses ACLs instead.
 *  - `baseDir` is created lazily on first save (mkdir recursive), so callers
 *    don't need to pre-create the directory.
 *
 * Concurrency:
 *  - GeyserClient calls `save()` inside its worker each time the checkpoint
 *    interval elapses. Two saves for the same key can overlap if the caller
 *    is enthusiastic about flushing; without serialization, the writeFile +
 *    rename interleavings can produce a file whose contents don't match
 *    either of the two "intended" checkpoints. A per-key promise chain
 *    guarantees each save's writeFile-then-rename completes before the next
 *    starts, so the on-disk file is always one of the saved `Checkpoint`s
 *    verbatim. Arrival-order serialization means the LAST queued save wins.
 *  - A failed save does not poison the chain: we attach a catch to the
 *    chain-tracking promise so later saves still execute.
 *
 * Key validation:
 *  - Keys go directly into filenames, so we reject anything that isn't
 *    `[a-zA-Z0-9_.-]+`. This rules out path separators, NUL bytes, whitespace,
 *    and the "dots only" traversal strings (".", ".."). See T11 FileVaultStorage
 *    for the same pattern.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Checkpoint, CheckpointStore } from './checkpoint-store';

/**
 * Allowed characters for checkpoint keys. Intentionally conservative:
 *  - letters, digits, underscore, dash, dot
 *  - no slash / backslash (path traversal)
 *  - no whitespace, no NUL
 *  - non-empty
 */
const SAFE_KEY = /^[a-zA-Z0-9_.-]+$/;

export interface FileCheckpointStoreOptions {
  /** Directory to store checkpoint files under. Created lazily on first save. */
  baseDir: string;
}

export class FileCheckpointStore implements CheckpointStore {
  readonly baseDir: string;

  /**
   * Per-key serialization chain. Each `save(key, …)` call appends onto any
   * in-flight save for the same key, so concurrent saves never have their
   * writeFile + rename interleaved. The stored promise is catch-wrapped so
   * a single I/O error can't permanently break the chain for that key.
   */
  readonly #mutexes = new Map<string, Promise<void>>();

  constructor(options: FileCheckpointStoreOptions) {
    this.baseDir = options.baseDir;
  }

  async load(key: string): Promise<Checkpoint | null> {
    try {
      const content = await fs.readFile(this.#pathFor(key), 'utf-8');
      return JSON.parse(content) as Checkpoint;
    } catch (e: unknown) {
      if (isNodeError(e) && e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async save(key: string, ckpt: Checkpoint): Promise<void> {
    // Validate synchronously so invalid keys throw to the caller immediately
    // instead of being swallowed into the chained promise.
    const finalPath = this.#pathFor(key);

    const prev = this.#mutexes.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.#doSave(finalPath, ckpt));
    // Keep the chain alive across errors so the next save for this key can
    // still run. Without this, a single ENOSPC / EPERM poisons the key
    // permanently for the life of the process.
    this.#mutexes.set(
      key,
      next.catch(() => {
        /* swallow to keep chain alive */
      }),
    );
    return next;
  }

  async #doSave(finalPath: string, ckpt: Checkpoint): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const tmpPath = `${finalPath}.tmp`;
    // Pretty-printed JSON keeps checkpoint files easy to inspect by hand in
    // prod; they're tiny so there's no meaningful size cost.
    await fs.writeFile(tmpPath, JSON.stringify(ckpt, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(tmpPath, finalPath);
    // Re-chmod after rename in case an older file at the final path had
    // different permissions. Best-effort on platforms that reject chmod.
    try {
      await fs.chmod(finalPath, 0o600);
    } catch {
      /* best effort — Windows + some mounted FS reject chmod */
    }
  }

  #pathFor(key: string): string {
    if (!SAFE_KEY.test(key)) {
      throw new Error(
        `FileCheckpointStore: invalid key '${key}' (allowed: a-z A-Z 0-9 _ . -)`,
      );
    }
    // `.` and `..` pass the charset filter but are still traversal hazards.
    if (/^\.+$/.test(key)) {
      throw new Error(`FileCheckpointStore: invalid key '${key}' (dots only)`);
    }
    return path.join(this.baseDir, `${key}.json`);
  }
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e;
}
