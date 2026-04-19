/**
 * RpcPool — round-robin, health-aware JSON-RPC client pool over
 * solana-core's `HttpClient`.
 *
 * Per spec Section 3.2 the pool:
 *
 *   - Accepts N endpoints, each with its own `HttpClient` (which owns its
 *     own circuit breaker, timeout, and per-attempt retries).
 *   - Round-robins `call()` across endpoints that are NOT `unhealthy`.
 *   - On failure, advances to the next endpoint and retries up to
 *     `retry.attempts` times *in total* across the pool.
 *   - Does NOT retry JSON-RPC method errors (`error.code` in the response
 *     envelope). These are deterministic per-request failures: retrying
 *     `getAccountInfo` with the same pubkey across a different endpoint
 *     won't make the account exist.
 *   - Emits one `metrics` event per `call()` regardless of outcome.
 *   - Exposes `pinForWrite()` which returns the lowest-EWMA non-unhealthy
 *     endpoint, for send-transaction workflows that want endpoint affinity.
 *
 * Design choices, called out:
 *
 *   - Endpoints are wrapped in an internal `EndpointState` that owns the
 *     `HttpClient`, `LatencyTracker`, and `HealthState`. The pool never
 *     exposes these wrappers to callers; `endpoints()` returns the original
 *     `RpcEndpoint` descriptors only.
 *
 *   - The round-robin cursor is advanced on *every* pick attempt (whether
 *     the endpoint was skipped for being unhealthy or not) so that
 *     selection pressure is distributed evenly over time. A "last healthy
 *     cursor" design instead would starve degraded endpoints that are
 *     trying to recover — we want to give them a chance once they come
 *     back from unhealthy.
 *
 *   - The breaker inside each `HttpClient` throws `rpc.circuit_open` — we
 *     treat that the same as any other transport failure (record error on
 *     the endpoint's HealthState, advance). The HttpClient's breaker is a
 *     *per-endpoint* fast-fail; the HealthState here is the *cross-pool*
 *     policy that moves traffic away.
 *
 *   - Retry budget is total across the pool, not per endpoint. With two
 *     endpoints and `attempts: 3` the sequence is A → B → A. If every
 *     endpoint were to retry internally, the tail latency would blow up.
 *
 *   - Metrics event shape is narrow and stable: `{ endpoint, healthState,
 *     latencyMs, errorClass?, retryCount }`. `errorClass` is omitted on
 *     success. `endpoint` is the endpoint *name* (e.g. `'helius'`), not the
 *     URL — dashboards should group by name, and URLs can rotate.
 */

import { EventEmitter } from 'node:events';

import { HttpClient, RpcError, type RetryPolicy } from '@ap3x/solana-core';

import { HealthState, type HealthStateName } from './health-state';
import { LatencyTracker } from './latency-tracker';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An RPC provider's connection descriptor. `name` is the stable telemetry
 * label; `kind` reserves room for gRPC endpoints (Yellowstone) alongside the
 * HTTP / JSON-RPC endpoints this pool targets today.
 */
export interface RpcEndpoint {
  name: 'helius' | 'triton' | 'quicknode' | 'custom';
  url: string;
  kind: 'http' | 'gRPC';
  /**
   * Weight hint for future load-balancing strategies. Ignored by the current
   * `'roundRobinReads'` strategy but accepted so configuration doesn't have
   * to change when a weighted strategy lands.
   */
  weight?: number;
}

/**
 * Strategy selector. Only `'roundRobinReads'` is implemented today; the
 * field exists so consumers can pin to a specific strategy now and keep
 * working when more land. An unknown string here is a configuration error.
 */
export type RpcPoolStrategy = 'roundRobinReads';

/** Metrics event emitted by the pool once per `call()`. */
export interface RpcMetricEvent {
  /** Endpoint `name` (not URL — stable label). */
  endpoint: string;
  /** Final health state of the endpoint that produced this call's result. */
  healthState: HealthStateName;
  /**
   * Wall-clock latency of the final attempt that succeeded, or the final
   * failed attempt if all tries were exhausted. Does not include backoff
   * time between attempts — that is bookkeeping, not RPC latency.
   */
  latencyMs: number;
  /**
   * When the call failed: short classification tag. Matches the `errorClass`
   * values produced by `HttpClient` (`'timeout'` | `'network'` | `'http'` |
   * `'circuit_open'`) plus `'rpc_method'` for JSON-RPC method errors.
   * Omitted on success.
   */
  errorClass?: string;
  /** Retries used — 0 = first attempt succeeded. */
  retryCount: number;
}

/** Placeholder method identifier union. Refined in later tasks. */
export type RpcMethod = string;

/** Per-method params map — opaque in the substrate scaffold. */
export type RpcParamsOf<_M extends RpcMethod> = unknown[] | Record<string, unknown>;

/** Per-method result type — opaque in the substrate scaffold. */
export type RpcResultOf<_M extends RpcMethod> = unknown;

/** Per-call overrides — timeout and AbortSignal today. */
export interface RpcCallOptions {
  /** Override the pool's default timeout for this one call. */
  timeoutMs?: number;
  /** Caller-provided abort signal. */
  signal?: AbortSignal;
}

/** Full pool configuration. */
export interface RpcPoolOptions {
  endpoints: RpcEndpoint[];
  /** Selection strategy. Only `'roundRobinReads'` is implemented today. */
  strategy?: RpcPoolStrategy;
  /**
   * Cross-pool retry policy. `attempts` includes the first try. Defaults to
   * 3 total attempts — i.e. one try per endpoint plus one extra with two
   * endpoints configured.
   */
  retry?: RetryPolicy;
  /** Default per-attempt timeout passed to each endpoint's HttpClient. */
  timeoutMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable delay for deterministic tests. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable random for jitter in backoff. */
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_RETRY: RetryPolicy = { attempts: 3, backoffMs: 50, jitter: 0.1 };
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Per-endpoint state bundle. The pool manages these; callers never see
 * them. One `HttpClient` instance per endpoint because (a) circuit breakers
 * are stateful per-origin, (b) `HttpClient` currently models exactly one
 * baseUrl.
 */
interface EndpointState {
  endpoint: RpcEndpoint;
  client: HttpClient;
  tracker: LatencyTracker;
  health: HealthState;
}

/**
 * Response envelope for JSON-RPC 2.0. Either `result` or `error` is present.
 */
interface RpcResponseEnvelope {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// RpcPool
// ---------------------------------------------------------------------------

export class RpcPool extends EventEmitter {
  readonly #states: EndpointState[];
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #delay: (ms: number) => Promise<void>;
  readonly #random: () => number;

  #cursor = 0;
  #rpcIdCounter = 0;

  constructor(opts: RpcPoolOptions) {
    super();
    if (opts.endpoints.length === 0) {
      // An empty pool is a config error that will manifest only on the first
      // call, far from where it was constructed — reject it eagerly.
      throw new TypeError('RpcPool requires at least one endpoint');
    }
    if (opts.strategy !== undefined && opts.strategy !== 'roundRobinReads') {
      // Accepting an unknown strategy silently and defaulting to round-robin
      // would hide typos. The `strategy` field's type will enforce this at
      // compile time, but we guard at runtime too for JS callers.
      throw new TypeError(`RpcPool: unknown strategy: ${String(opts.strategy)}`);
    }

    this.#retry = opts.retry ?? DEFAULT_RETRY;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = opts.now ?? Date.now;
    this.#delay =
      opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.#random = opts.random ?? Math.random;

    this.#states = opts.endpoints.map((endpoint) => ({
      endpoint,
      // Each endpoint gets a fresh HttpClient. `attempts: 1` means the
      // HttpClient will not retry internally — the pool orchestrates retries
      // across endpoints instead. This prevents the `attempts ×
      // endpoints × pool-attempts` blow-up that would happen if both layers
      // retried.
      client: new HttpClient({
        baseUrl: endpoint.url,
        timeoutMs: this.#timeoutMs,
        retry: { attempts: 1, backoffMs: 0, jitter: 0 },
        now: this.#now,
        delay: this.#delay,
        random: this.#random,
      }),
      tracker: new LatencyTracker(),
      health: new HealthState(),
    }));
  }

  /**
   * List configured endpoints. Returns the original descriptors — internal
   * per-endpoint state is not exposed. Readonly so callers can't mutate the
   * pool's configuration post-hoc.
   */
  endpoints(): ReadonlyArray<RpcEndpoint> {
    return this.#states.map((s) => s.endpoint);
  }

  /**
   * Subscribe to pool metrics. Returns `this` for chaining, matching the
   * `EventEmitter.on` convention.
   */
  override on(event: 'metrics', handler: (ev: RpcMetricEvent) => void): this;
  override on(event: string | symbol, handler: (...args: unknown[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  /**
   * Pin the lowest-EWMA non-unhealthy endpoint, preferring `healthy` over
   * `degraded`. Intended for write operations (sendTransaction) where
   * endpoint affinity matters — staying on one endpoint avoids cross-node
   * inconsistency windows when confirming a freshly-sent tx.
   *
   * If every endpoint is unhealthy this throws `ConfigError`-adjacent
   * behaviour via `RpcError('circuit_open', ...)` — there is no sensible
   * "pin" when nothing is callable.
   */
  pinForWrite(): RpcEndpoint {
    // Prefer healthy over degraded; within each tier pick the lowest EWMA.
    // Unseeded trackers (`ewma() === Infinity`) sort last, so a healthy
    // endpoint with no samples still beats a degraded one with real data.
    const healthy = this.#states.filter((s) => s.health.state() === 'healthy');
    const degraded = this.#states.filter((s) => s.health.state() === 'degraded');
    const pool = healthy.length > 0 ? healthy : degraded;
    if (pool.length === 0) {
      throw new RpcError('circuit_open', 'no healthy endpoints available');
    }
    // Stable sort: Array.sort() in V8 is stable, so equal-EWMA endpoints
    // keep their configured order — reproducible selection under ties.
    const sorted = [...pool].sort((a, b) => a.tracker.ewma() - b.tracker.ewma());
    // sorted.length >= 1 proven above, so [0] is defined; assert to satisfy
    // `noUncheckedIndexedAccess`.
    return sorted[0]!.endpoint;
  }

  /**
   * Issue a JSON-RPC call. Rounds-robin across non-unhealthy endpoints,
   * retrying on transport failures up to `retry.attempts` total. Returns
   * the decoded `result` field on success; throws `RpcError` on failure.
   *
   * `rpc_method` errors are never retried — these are deterministic
   * per-request responses from the RPC node (e.g. "account not found").
   */
  async call<M extends RpcMethod>(
    method: M,
    params: RpcParamsOf<M>,
    opts?: RpcCallOptions,
  ): Promise<RpcResultOf<M>> {
    // `retry.attempts` is total tries including the first. For a 2-endpoint
    // pool with attempts=3 we try A, then B, then A again. The last result
    // (success OR final failure) drives the metrics event.
    let retryCount = 0;
    let lastState: EndpointState | undefined;
    let lastLatencyMs = 0;
    let lastErrorClass: string | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#retry.attempts; attempt++) {
      const state = this.#pickEndpoint();
      if (!state) {
        // No non-unhealthy endpoints. Don't keep retrying — advancing the
        // cursor won't help. Bail with a `circuit_open` classification; it
        // maps cleanly onto "nothing is callable right now".
        lastErrorClass = 'circuit_open';
        lastError = new RpcError('circuit_open', 'no healthy endpoints available');
        // No `lastState` — we never picked one. Emit a metrics event with
        // the most recently attempted endpoint if any, otherwise fall
        // through to the throw below.
        break;
      }

      const attemptStartedAt = this.#now();
      try {
        const result = await this.#sendOnce(state, method, params, opts);
        const latencyMs = this.#now() - attemptStartedAt;
        state.tracker.record(latencyMs);
        state.health.recordSuccess();
        this.#emitMetrics({
          endpoint: state.endpoint.name,
          healthState: state.health.state(),
          latencyMs,
          retryCount,
        });
        return result as RpcResultOf<M>;
      } catch (err) {
        const latencyMs = this.#now() - attemptStartedAt;
        lastState = state;
        lastLatencyMs = latencyMs;
        lastError = err;

        if (err instanceof RpcError && err.code === 'rpc.rpc_method') {
          // JSON-RPC method errors are deterministic. Record latency and a
          // successful-transport (health-wise) outcome — the node responded,
          // it just didn't like the request. Emit metrics and rethrow.
          state.tracker.record(latencyMs);
          // Method errors are transport successes: the node responded with a
          // valid JSON-RPC envelope. Record a success so one bad request
          // doesn't falsely promote the endpoint toward `degraded`.
          state.health.recordSuccess();
          this.#emitMetrics({
            endpoint: state.endpoint.name,
            healthState: state.health.state(),
            latencyMs,
            errorClass: 'rpc_method',
            retryCount,
          });
          throw err;
        }

        // Transport failure: record latency + error on the health state,
        // classify, advance to the next endpoint.
        state.tracker.record(latencyMs);
        state.health.recordError();
        lastErrorClass = this.#classifyError(err);

        const isLastAttempt = attempt === this.#retry.attempts;
        if (!isLastAttempt) {
          await this.#delay(this.#backoff(attempt));
          retryCount = attempt;
          continue;
        }
      }
    }

    // All attempts exhausted. `lastState` is defined whenever we actually
    // reached an endpoint; if we never did (all unhealthy on first pick),
    // fall back to the first configured endpoint for metrics labelling —
    // better than omitting the event. We still throw `lastError`.
    const labelState = lastState ?? this.#states[0]!;
    this.#emitMetrics({
      endpoint: labelState.endpoint.name,
      healthState: labelState.health.state(),
      latencyMs: lastLatencyMs,
      errorClass: lastErrorClass ?? 'network',
      retryCount,
    });
    throw lastError ?? new RpcError('http', 'rpc pool exhausted');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Round-robin selection of the next non-unhealthy endpoint. Advances the
   * cursor by one per call. Returns `undefined` if every endpoint is
   * unhealthy. Prefers healthy over degraded — we only consider degraded
   * endpoints when no healthy peer exists at the current cursor position.
   */
  #pickEndpoint(): EndpointState | undefined {
    const total = this.#states.length;
    // First pass: find the next `healthy` endpoint, cursor-relative.
    for (let i = 0; i < total; i++) {
      const idx = (this.#cursor + i) % total;
      const state = this.#states[idx]!;
      if (state.health.state() === 'healthy') {
        this.#cursor = (idx + 1) % total;
        return state;
      }
    }
    // Second pass: no healthy endpoint exists; accept a degraded one.
    for (let i = 0; i < total; i++) {
      const idx = (this.#cursor + i) % total;
      const state = this.#states[idx]!;
      if (state.health.state() === 'degraded') {
        this.#cursor = (idx + 1) % total;
        return state;
      }
    }
    return undefined;
  }

  /**
   * Issue one JSON-RPC POST to the chosen endpoint. Decodes the envelope;
   * throws `RpcError('rpc_method', ...)` on a JSON-RPC `error` field and
   * `RpcError('parse', ...)` on a malformed response body.
   */
  async #sendOnce(
    state: EndpointState,
    method: RpcMethod,
    params: RpcParamsOf<RpcMethod>,
    opts: RpcCallOptions | undefined,
  ): Promise<unknown> {
    const id = ++this.#rpcIdCounter;
    const body = { jsonrpc: '2.0' as const, id, method, params };

    // Build RequestInit — only include `signal` if the caller provided one,
    // since `exactOptionalPropertyTypes` treats `undefined` differently from
    // "key absent".
    const init: RequestInit = {};
    if (opts?.signal) {
      init.signal = opts.signal;
    }

    const response = await state.client.post('', body, init);
    let envelope: RpcResponseEnvelope;
    try {
      envelope = (await response.json()) as RpcResponseEnvelope;
    } catch (err) {
      throw new RpcError(
        'parse',
        'invalid JSON-RPC response body',
        { endpoint: state.endpoint.url, method },
        { cause: err },
      );
    }

    if (envelope.error) {
      throw new RpcError(
        'rpc_method',
        envelope.error.message,
        {
          endpoint: state.endpoint.url,
          method,
          rpcCode: envelope.error.code,
        },
      );
    }

    return envelope.result;
  }

  /**
   * Classify a thrown error for the metrics event's `errorClass` field.
   * Mirrors `HttpClient`'s `HttpErrorClass` strings so dashboards that
   * already segment on those values keep working.
   */
  #classifyError(err: unknown): string {
    if (err instanceof RpcError) {
      // `rpc.timeout` → `'timeout'`, `rpc.http` → `'http'`, `rpc.rate_limited`
      // → `'rate_limited'`, `rpc.circuit_open` → `'circuit_open'`,
      // `rpc.parse` → `'parse'`.
      return err.code.slice('rpc.'.length);
    }
    return 'network';
  }

  /** Exponential backoff with multiplicative jitter. Mirrors HttpClient. */
  #backoff(attempt: number): number {
    const base = this.#retry.backoffMs * Math.pow(2, attempt - 1);
    const factor = 1 + this.#random() * this.#retry.jitter;
    return base * factor;
  }

  #emitMetrics(ev: RpcMetricEvent): void {
    this.emit('metrics', ev);
  }
}
