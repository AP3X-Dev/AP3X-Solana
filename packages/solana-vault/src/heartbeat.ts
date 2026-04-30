import { renameSync, writeFileSync, readFileSync } from 'node:fs';

/**
 * `lastWriteAt`-style liveness probe for the vault. The vault layer calls
 * {@link tick} after every successful unlock or write; an out-of-process
 * watchdog reads either the in-memory snapshot via {@link readHeartbeatFile}
 * (when persistence is configured) or queries this object directly when the
 * watchdog is in-process.
 *
 * Differs from `@ap3x/solana-webhooks` `Healthz`: this primitive is intended
 * to be stat-readable from a sibling process, so the persistence path matters.
 * The webhook probe is HTTP-shaped; this one is filesystem-shaped.
 */
export class VaultHeartbeat {
  private lastAt: number | null;
  private readonly path: string | null;
  private readonly now: () => number;

  constructor(opts: VaultHeartbeatOptions = {}) {
    this.path = opts.path ?? null;
    this.now = opts.now ?? Date.now;
    this.lastAt = opts.startedAt ?? null;
  }

  /**
   * Stamp the most-recent-write timestamp. Call from the vault's success
   * paths only — failures must NOT tick, otherwise the watchdog can't
   * distinguish a stuck-but-callable vault from a healthy one.
   *
   * When a persistence path is configured, the timestamp is durably written
   * via temp-file-then-rename so an external reader either sees the previous
   * value or the new one — never a torn read.
   */
  tick(at: number = this.now()): void {
    this.lastAt = at;
    if (this.path !== null) {
      const body = JSON.stringify({ lastWriteAt: at, iso: new Date(at).toISOString() });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, this.path);
    }
  }

  /** In-memory snapshot. `ageMs` is `null` when no tick has been recorded. */
  snapshot(): VaultHeartbeatSnapshot {
    if (this.lastAt === null) return { lastWriteAt: null, ageMs: null };
    return { lastWriteAt: this.lastAt, ageMs: this.now() - this.lastAt };
  }
}

export interface VaultHeartbeatOptions {
  /** Filesystem path for the durable timestamp. Omit for in-memory only. */
  path?: string;
  /** Initial timestamp; if absent, snapshot reports a null heartbeat. */
  startedAt?: number;
  /** Now-function for testability. */
  now?: () => number;
}

export interface VaultHeartbeatSnapshot {
  lastWriteAt: number | null;
  ageMs: number | null;
}

/**
 * Read a heartbeat file produced by {@link VaultHeartbeat.tick}. Out-of-
 * process watchdogs use this to compute staleness without IPC. Returns
 * `null` when the file is missing or unreadable; throws if the file exists
 * but is not the expected JSON shape (so a corrupt file is not silently
 * treated as "fine").
 */
export function readHeartbeatFile(path: string): VaultHeartbeatPersisted | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as { lastWriteAt?: unknown }).lastWriteAt !== 'number'
  ) {
    throw new Error(`heartbeat file ${path} is not a valid heartbeat snapshot`);
  }
  return parsed as VaultHeartbeatPersisted;
}

export interface VaultHeartbeatPersisted {
  lastWriteAt: number;
  iso: string;
}
