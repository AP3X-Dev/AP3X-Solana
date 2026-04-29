import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Liveness probe for a webhook ingestion pipeline. Tracks the timestamp of
 * the most recent successful event acceptance and reports unhealthy when
 * silence exceeds a configurable threshold. Exposes a Node `http`-compatible
 * handler for the canonical `/healthz` shape.
 *
 * The class is mutable on purpose: the HTTP receiver and the drainer both
 * call {@link recordEvent} from their hot paths, and a single instance per
 * process is the expected wiring. Memory cost is one timestamp.
 */
export class Healthz {
  private lastAt: number | null;
  private readonly silentThresholdMs: number;
  private readonly now: () => number;

  constructor(opts: HealthzOptions = {}) {
    this.silentThresholdMs = opts.silentThresholdMs ?? DEFAULT_SILENT_THRESHOLD_MS;
    this.now = opts.now ?? Date.now;
    this.lastAt = opts.startedAt ?? null;
  }

  /** Stamp the most-recent-event timestamp. Call after every accepted event. */
  recordEvent(at: number = this.now()): void {
    this.lastAt = at;
  }

  /** Last accepted-event timestamp, or `null` if none seen yet. */
  lastEventAt(): Date | null {
    return this.lastAt === null ? null : new Date(this.lastAt);
  }

  /**
   * `true` if events have been seen within the silent threshold. `false` if
   * no events have been seen at all *or* the gap exceeds the threshold.
   *
   * The "no events ever" case returns `false` rather than `true` so a freshly-
   * deployed process that hasn't yet received traffic doesn't pass liveness;
   * upstream load balancers should give it a startup grace via their own
   * `initialDelaySeconds`.
   */
  isHealthy(): boolean {
    if (this.lastAt === null) return false;
    return this.now() - this.lastAt <= this.silentThresholdMs;
  }

  /**
   * Build a Node `http`-compatible request handler. Returns 200 + JSON when
   * healthy, 503 + JSON when not. The body shape is stable for ops tooling:
   *   { healthy: boolean, lastEventAt: ISO-string | null, silentThresholdMs: number }
   */
  handler(): (req: IncomingMessage, res: ServerResponse) => void {
    return (_req, res) => {
      const healthy = this.isHealthy();
      const last = this.lastEventAt();
      const body = {
        healthy,
        lastEventAt: last ? last.toISOString() : null,
        silentThresholdMs: this.silentThresholdMs,
      };
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
  }
}

export interface HealthzOptions {
  /** Default 60s. Overrideable per deployment SLO. */
  silentThresholdMs?: number;
  /** Initial timestamp; if absent, the probe starts unhealthy. */
  startedAt?: number;
  /** Now-function for testability. */
  now?: () => number;
}

export const DEFAULT_SILENT_THRESHOLD_MS = 60_000;
