/**
 * `FileStrategyStateStore` — the default file-backed `StrategyStateStore`.
 *
 * Layout:
 *   `<dir>/<strategyName>/<instanceId>/<key>.json`
 *
 * Durability:
 *   Writes go to a `.tmp.<pid>.<ts>` file first, then atomically renamed into
 *   place. On POSIX, rename within the same filesystem is a true atomic swap;
 *   on Windows the semantics are slightly weaker but still avoid the
 *   half-written-JSON failure mode. Orphan tmp files from prior crashes are
 *   harmless — `get` reads only `<key>.json`.
 *
 * Concurrency:
 *   A per-key promise-chain mutex serialises concurrent writes for the same
 *   key so the tmp+rename sequence never interleaves. The mutex chain is
 *   captured into a variable (`chain`) so the equality-check on cleanup
 *   compares against the exact same Promise object that was stored in the map
 *   (each `.then()` call returns a new Promise, so comparing against a fresh
 *   `.then()` call would never be equal — see `FilePortfolioStore.withMutex`
 *   for the canonical pattern in this repo).
 *
 * Key sanitization:
 *   Non-alphanumeric characters except `_` and `-` are replaced with `_`.
 *   Callers must be aware that `a/b` and `a_b` both map to `a_b.json`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { StrategyStateStore } from './context.js';

export interface FileStrategyStateStoreOpts {
  /** Root directory. Defaults to `.ap3x/strategy`. */
  dir?: string;
  /** Strategy name — used as a path segment below `dir`. */
  strategyName: string;
  /** Instance identifier — used as a path segment below `strategyName`. */
  instanceId: string;
}

export class FileStrategyStateStore implements StrategyStateStore {
  private readonly dir: string;
  /**
   * Per-key mutex map. The stored promise is the "gate" that the next queued
   * operation awaits. We store the catch-wrapped chain (not the raw operation
   * promise) so a single I/O error never permanently blocks subsequent writes
   * for the same key.
   */
  private readonly mutexes = new Map<string, Promise<void>>();

  constructor(opts: FileStrategyStateStoreOpts) {
    const root = opts.dir ?? '.ap3x/strategy';
    this.dir = path.join(root, opts.strategyName, opts.instanceId);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.pathFor(key), 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    return this.withMutex(key, async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const p = this.pathFor(key);
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
      await fs.rename(tmp, p);
    });
  }

  async delete(key: string): Promise<void> {
    return this.withMutex(key, async () => {
      try {
        await fs.unlink(this.pathFor(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    });
  }

  async list(prefix?: string): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dir);
      return files
        .filter((f) => f.endsWith('.json') && !f.includes('.tmp.'))
        .map((f) => f.slice(0, -'.json'.length))
        .filter((k) => !prefix || k.startsWith(prefix));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private pathFor(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  /**
   * Per-key mutex via promise chaining.
   *
   * The key insight: we capture the chained promise (`chain = prev.then(...)`)
   * into a local variable and store *that same reference* in `mutexes`. The
   * cleanup check after `fn()` compares `mutexes.get(key)` against `chain` —
   * both point at the same Promise object, so the equality holds when this
   * is the last queued operation and it is safe to evict the entry.
   *
   * If we had stored `prev.then(() => next)` in the map but compared against a
   * freshly evaluated `prev.then(() => next)` in the if-check, the comparison
   * would never be equal (each `.then()` returns a distinct Promise instance).
   *
   * The catch-wrap on `chain` keeps the mutex chain alive across I/O errors so
   * subsequent operations for the same key still execute after a transient
   * failure.
   */
  private async withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(key) ?? Promise.resolve();

    let resolveOuter!: () => void;
    const gate = new Promise<void>((res) => {
      resolveOuter = res;
    });

    // `chain` is the promise we store in the map. It resolves when `gate`
    // resolves (i.e. when the current operation finishes). The catch-wrap
    // ensures I/O errors don't permanently poison the chain.
    const chain = prev.then(() => gate).catch(() => gate);
    this.mutexes.set(key, chain);

    // Wait for all previously queued operations on this key to complete.
    await prev;
    try {
      return await fn();
    } finally {
      resolveOuter();
      // Evict the map entry only if no newer operation has replaced it.
      // `chain` is the exact same reference we stored above, so this check
      // is reliable. (A freshly created `.then()` call would NOT be ===.)
      if (this.mutexes.get(key) === chain) {
        this.mutexes.delete(key);
      }
    }
  }
}
