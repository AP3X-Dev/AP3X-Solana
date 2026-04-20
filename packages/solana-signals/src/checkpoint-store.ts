/**
 * `FileSignalCheckpointStore` — file-backed `SignalCheckpointStore` for
 * signal subscribers.
 *
 * Layout: `<dir>/<subscriber>.json` — one file per subscriber. The file is
 * plain JSON-serialized `SignalCheckpoint`. A sibling `.tmp` file may appear
 * briefly during a write but is renamed into place atomically on success.
 *
 * Durability / crash-safety:
 *  - Writes go to a `.tmp` file first and are atomically renamed. On POSIX,
 *    rename within the same filesystem is atomic; on Windows the semantics
 *    are slightly weaker but still avoid the "half-written JSON" failure mode.
 *  - Files are created with mode `0o600` on POSIX (world-unreadable).
 *    Windows ignores mode and uses ACLs instead.
 *  - `dir` is created lazily on first save (mkdir recursive).
 *
 * Concurrency:
 *  - Per-subscriber promise chain serializes concurrent saves so writeFile +
 *    rename for the same subscriber never interleave. Arrival-order
 *    serialization means the LAST queued save wins.
 *  - A failed save does not poison the chain: catch-wrapped chain-tracking
 *    promise ensures later saves for the same subscriber still execute.
 *
 * Subscriber name sanitization:
 *  - Non-alphanumeric characters (except `_` and `-`) are replaced with `_`
 *    to produce a safe filename.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface SignalCheckpoint {
  lastSignalId: string;
  lastSlot: number;
}

export interface SignalCheckpointStore {
  load(subscriber: string): Promise<SignalCheckpoint | null>;
  save(subscriber: string, ckpt: SignalCheckpoint): Promise<void>;
}

export interface FileSignalCheckpointStoreOpts {
  /** Directory to store checkpoint files under. Created lazily on first save. */
  dir?: string;
}

export class FileSignalCheckpointStore implements SignalCheckpointStore {
  private readonly dir: string;

  /**
   * Per-subscriber serialization chain. Each `save(subscriber, …)` call
   * appends onto any in-flight save for the same subscriber, so concurrent
   * saves never have their writeFile + rename interleaved. The stored promise
   * is catch-wrapped so a single I/O error can't permanently break the chain
   * for that subscriber.
   */
  readonly #mutexes = new Map<string, Promise<void>>();

  constructor(opts: FileSignalCheckpointStoreOpts = {}) {
    this.dir = opts.dir ?? '.ap3x/signals';
  }

  async load(subscriber: string): Promise<SignalCheckpoint | null> {
    try {
      const content = await fs.readFile(this.#pathFor(subscriber), 'utf-8');
      return JSON.parse(content) as SignalCheckpoint;
    } catch (e: unknown) {
      if (isNodeError(e) && e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async save(subscriber: string, ckpt: SignalCheckpoint): Promise<void> {
    const finalPath = this.#pathFor(subscriber);

    const prev = this.#mutexes.get(subscriber) ?? Promise.resolve();
    const next = prev.then(() => this.#doSave(finalPath, ckpt));
    // Keep the chain alive across errors so subsequent saves for this
    // subscriber still execute after a transient I/O failure.
    this.#mutexes.set(
      subscriber,
      next.catch(() => {
        /* swallow to keep chain alive */
      }),
    );
    return next;
  }

  async #doSave(finalPath: string, ckpt: SignalCheckpoint): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(ckpt, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(tmpPath, finalPath);
    // Re-chmod after rename — best-effort on platforms that reject chmod.
    try {
      await fs.chmod(finalPath, 0o600);
    } catch {
      /* best effort — Windows + some mounted FS reject chmod */
    }
  }

  #pathFor(subscriber: string): string {
    const safe = subscriber.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e;
}
