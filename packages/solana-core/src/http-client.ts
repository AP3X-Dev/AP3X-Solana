/**
 * HttpClient — substrate-internal HTTP plumbing with retry, timeout, and a
 * circuit breaker. Lifted+relicensed from Chad's PRP-1 `HttpClient` pattern,
 * adapted to the AP3X error hierarchy + zero-dep stance (native fetch,
 * native AbortController, native EventEmitter).
 *
 * Design:
 *
 *   - Constructor options are mostly optional: `retry` defaults to one
 *     attempt (i.e. no retries), `circuitBreaker` is disabled unless given.
 *     `timeoutMs` is **required** per the spec because "no timeout" is a
 *     footgun we don't want to make easy.
 *
 *   - The single code path for all HTTP work is {@link HttpClient.request}.
 *     {@link HttpClient.get} / {@link HttpClient.post} just rewrite arguments
 *     and delegate. This keeps retry/timeout/circuit/metrics in exactly one
 *     place and makes it reviewable.
 *
 *   - Retries on: network failure (`fetch` rejection), 5xx, 429 (with
 *     optional `Retry-After` honoured). Never on: 2xx, 3xx, 4xx except 429.
 *
 *   - Backoff is `backoffMs * 2^(attempt-1) * (1 + random() * jitter)`.
 *     Multiplicative jitter keeps the minimum wait stable (the base backoff)
 *     while adding up to `jitter * base` extra on top.
 *
 *   - Circuit breaker is a plain state machine with three states:
 *     `closed → open → half-open → closed`. In `half-open` we allow
 *     exactly ONE request through; the outcome of that request decides the
 *     next transition. State transitions emit `circuit:open`,
 *     `circuit:half-open`, `circuit:closed` events.
 *
 *   - Every call emits exactly one `metrics` event at the end of `request()`,
 *     including circuit-rejected calls that never touched the network.
 *     `retryCount` reflects attempts used (0 = succeeded first try).
 *
 *   - Clock, delay, and jitter are injectable for deterministic tests. No
 *     use of `vi.useFakeTimers()` is needed — tests pass their own
 *     `now()` / `delay()` / `random()` and advance time manually.
 */

import { EventEmitter } from 'node:events';

import { RpcError, TimeoutError } from './errors';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Retry policy. `attempts` is the TOTAL number of tries including the first:
 * `attempts: 3` means 1 initial call + up to 2 retries.
 */
export interface RetryPolicy {
  /** Total attempts including the first. Must be >= 1. */
  attempts: number;
  /** Base backoff in milliseconds. Delay for attempt N is `backoffMs * 2^(N-1)`. */
  backoffMs: number;
  /**
   * Multiplicative jitter factor, range 0..1. The actual delay is
   * `base * (1 + random() * jitter)` — so 0 disables jitter, 0.5 adds up to
   * 50% on top of the base backoff.
   */
  jitter: number;
}

/**
 * Circuit breaker policy. Absence on the client means the breaker is
 * entirely disabled — the client will always attempt the request.
 */
export interface CircuitBreakerPolicy {
  /** Consecutive failures required to transition from closed → open. */
  failureThreshold: number;
  /** Time in open state before the next request is allowed through (half-open). */
  recoveryMs: number;
}

export interface HttpClientOptions {
  /**
   * Base URL prepended to relative paths. Absolute URLs passed to
   * `request()` bypass this.
   */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Required — no sane default exists. */
  timeoutMs: number;
  retry?: RetryPolicy;
  circuitBreaker?: CircuitBreakerPolicy;

  /** Injectable clock; defaults to `Date.now`. Used for circuit-breaker timing + latency. */
  now?: () => number;
  /** Injectable sleep; defaults to a real `setTimeout` promise. Tests inject a no-op. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable `Math.random`, used only for jitter computation. */
  random?: () => number;
}

/**
 * Shape of the single `metrics` event emitted per `request()` call.
 *
 * Exported so callers can type their listener without importing the
 * EventEmitter ever-expanding any-map.
 */
export interface HttpMetrics {
  /** Wall-clock latency of the whole `request()` call including retries. */
  latencyMs: number;
  /** Final HTTP status code, if a response was produced. Undefined on network/timeout/circuit. */
  statusCode?: number;
  /** Coarse error classification; undefined on success. */
  errorClass?: HttpErrorClass;
  /** Retries used. 0 = first attempt succeeded. */
  retryCount: number;
}

export type HttpErrorClass = 'timeout' | 'network' | 'http' | 'circuit_open';

/**
 * Circuit-breaker state. `closed` is healthy. `open` short-circuits all
 * requests. `half-open` allows exactly one probe through.
 */
type CircuitState = 'closed' | 'open' | 'half-open';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_RETRY: RetryPolicy = { attempts: 1, backoffMs: 0, jitter: 0 };

// ---------------------------------------------------------------------------
// HttpClient
// ---------------------------------------------------------------------------

export class HttpClient extends EventEmitter {
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly breaker: CircuitBreakerPolicy | undefined;

  private readonly _now: () => number;
  private readonly _delay: (ms: number) => Promise<void>;
  private readonly _random: () => number;

  // Breaker state
  private _state: CircuitState = 'closed';
  private _consecutiveFailures = 0;
  private _openedAt = 0;

  constructor(opts: HttpClientOptions) {
    super();
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.breaker = opts.circuitBreaker;
    this._now = opts.now ?? Date.now;
    this._delay =
      opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this._random = opts.random ?? Math.random;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get(path: string, opts?: RequestInit): Promise<Response> {
    return this.request('GET', path, opts);
  }

  post(path: string, body: unknown, opts?: RequestInit): Promise<Response> {
    // Normalize the body: objects → JSON string + Content-Type header;
    // string / Uint8Array pass through untouched. `null`/`undefined` is
    // omitted (no body). Anything else (number, boolean) is also JSON'd,
    // which is the safer default for RPC clients.
    const init: RequestInit = { ...(opts ?? {}) };
    if (body === undefined || body === null) {
      // leave body unset
    } else if (typeof body === 'string' || body instanceof Uint8Array) {
      // RequestInit['body'] in the DOM lib is BodyInit, but `lib: ES2022` only
      // has undici's narrower typing from @types/node. A string / Uint8Array
      // are both valid runtime bodies; cast through unknown to paper over the
      // lib skew without pulling in the full DOM types. The `NonNullable` is
      // needed because exactOptionalPropertyTypes treats `init.body = x` as
      // incompatible with `undefined`.
      init.body = body as unknown as NonNullable<RequestInit['body']>;
    } else {
      init.body = JSON.stringify(body);
      const headers = new Headers(init.headers);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      init.headers = headers;
    }
    return this.request('POST', path, init);
  }

  /**
   * The one code path — all other entry points route here. Implements:
   *   1. Circuit-breaker pre-check (reject-fast if open and not yet recovered).
   *   2. Retry loop with exponential+jittered backoff.
   *   3. Per-attempt AbortController for timeout, composed with the caller's
   *      signal (if any).
   *   4. Final metrics emission, regardless of outcome.
   */
  async request(method: string, path: string, init?: RequestInit): Promise<Response> {
    const startedAt = this._now();
    let retryCount = 0;

    // Pre-check the breaker. If it is open and the recovery window has not
    // elapsed, fail fast without even attempting the network.
    const breakerDecision = this._breakerPreCheck();
    if (breakerDecision === 'reject') {
      const err = new RpcError('http', 'circuit open', { endpoint: path });
      this._emitMetrics({
        latencyMs: this._now() - startedAt,
        retryCount: 0,
        errorClass: 'circuit_open',
      });
      throw err;
    }

    const url = this._resolveUrl(path);
    let lastFailure: { kind: HttpErrorClass; statusCode?: number; err: unknown } | undefined;

    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      let response: Response | undefined;
      let attemptErr: { kind: HttpErrorClass; statusCode?: number; err: unknown } | undefined;

      try {
        response = await this._fetchOnce(method, url, init);
      } catch (err) {
        // Classify: TimeoutError vs. network failure.
        if (err instanceof TimeoutError) {
          attemptErr = { kind: 'timeout', err };
        } else {
          attemptErr = { kind: 'network', err };
        }
      }

      if (response && !this._isRetryableStatus(response.status)) {
        // Either a 2xx/3xx (success) or a non-retryable 4xx (final failure).
        if (response.ok) {
          this._recordSuccess();
          this._emitMetrics({
            latencyMs: this._now() - startedAt,
            statusCode: response.status,
            retryCount,
          });
          return response;
        }
        // Non-retryable HTTP error — fail out immediately.
        this._recordFailure();
        const httpErr = new RpcError(
          'http',
          `HTTP ${response.status}`,
          { endpoint: url, statusCode: response.status },
        );
        this._emitMetrics({
          latencyMs: this._now() - startedAt,
          statusCode: response.status,
          retryCount,
          errorClass: 'http',
        });
        throw httpErr;
      }

      // We either got a retryable status or an error. Decide whether to
      // keep going.
      if (response && this._isRetryableStatus(response.status)) {
        lastFailure = {
          kind: 'http',
          statusCode: response.status,
          err: new RpcError(
            'http',
            `HTTP ${response.status}`,
            { endpoint: url, statusCode: response.status },
          ),
        };
      } else if (attemptErr) {
        lastFailure = attemptErr;
      }

      const isLastAttempt = attempt === this.retry.attempts;
      if (isLastAttempt) {
        break;
      }

      // Compute backoff; honour `Retry-After` if we got a 429 with one.
      let wait = this._backoff(attempt);
      if (response && response.status === 429) {
        const ra = response.headers.get('retry-after');
        if (ra) {
          const parsed = Number.parseInt(ra, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            wait = parsed * 1000;
          }
        }
      }
      await this._delay(wait);
      retryCount = attempt; // we've just consumed attempt N, will try N+1
    }

    // All attempts exhausted.
    this._recordFailure();
    const kind = lastFailure?.kind ?? 'network';
    const statusCode = lastFailure?.statusCode;
    const err = lastFailure?.err ?? new RpcError('http', 'request failed', { endpoint: url });
    this._emitMetrics({
      latencyMs: this._now() - startedAt,
      retryCount,
      errorClass: kind,
      ...(statusCode !== undefined ? { statusCode } : {}),
    });
    throw err;
  }

  // -------------------------------------------------------------------------
  // Internals — fetch one attempt with timeout
  // -------------------------------------------------------------------------

  private async _fetchOnce(
    method: string,
    url: string,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const internal = new AbortController();
    const timer = setTimeout(() => {
      internal.abort(new DOMException('timeout', 'AbortError'));
    }, this.timeoutMs);

    // Compose the internal abort signal with any caller-provided signal.
    // Use `AbortSignal.any` when available (Node 20.3+); otherwise wire up
    // a manual listener.
    let signal: AbortSignal;
    const callerSignal = init?.signal ?? undefined;
    const anyCtor = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
    if (callerSignal) {
      if (typeof anyCtor === 'function') {
        signal = anyCtor([internal.signal, callerSignal]);
      } else {
        // Manual compose: abort internal when caller aborts.
        if (callerSignal.aborted) internal.abort(callerSignal.reason);
        else callerSignal.addEventListener('abort', () => internal.abort(callerSignal.reason), { once: true });
        signal = internal.signal;
      }
    } else {
      signal = internal.signal;
    }

    try {
      const fetchInit: RequestInit = {
        ...(init ?? {}),
        method,
        signal,
      };
      const res = await fetch(url, fetchInit);
      return res;
    } catch (err) {
      // An `AbortError` caused by our timeout becomes a TimeoutError. An
      // AbortError from the caller's signal propagates as-is (the caller
      // explicitly asked to cancel). Anything else is a network failure.
      if (this._isAbortFromTimeout(err, internal.signal, callerSignal)) {
        throw new TimeoutError('HTTP request timed out', {
          op: 'http',
          timeoutMs: this.timeoutMs,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private _isAbortFromTimeout(
    err: unknown,
    internalSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): boolean {
    // If the caller's signal also fired, we can't tell for sure who won;
    // prefer the caller's cancel (they asked for it). Only classify as
    // timeout when our internal signal fired AND the caller's didn't.
    const looksAbort =
      err instanceof Error &&
      (err.name === 'AbortError' ||
        // node-fetch / undici variants
        (err as { code?: string }).code === 'ABORT_ERR');
    if (!looksAbort) return false;
    if (callerSignal?.aborted) return false;
    return internalSignal.aborted;
  }

  // -------------------------------------------------------------------------
  // Internals — retry policy helpers
  // -------------------------------------------------------------------------

  private _isRetryableStatus(status: number): boolean {
    if (status >= 500 && status <= 599) return true;
    if (status === 429) return true;
    return false;
  }

  private _backoff(attempt: number): number {
    // attempt is 1-indexed: first retry delay uses attempt=1 → 2^0.
    const base = this.retry.backoffMs * Math.pow(2, attempt - 1);
    const factor = 1 + this._random() * this.retry.jitter;
    return base * factor;
  }

  private _resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (!this.baseUrl) return path;
    if (this.baseUrl.endsWith('/') && path.startsWith('/')) {
      return this.baseUrl + path.slice(1);
    }
    if (!this.baseUrl.endsWith('/') && !path.startsWith('/')) {
      return this.baseUrl + '/' + path;
    }
    return this.baseUrl + path;
  }

  // -------------------------------------------------------------------------
  // Internals — circuit breaker state machine
  // -------------------------------------------------------------------------

  /**
   * Consulted before every network attempt. Returns `'reject'` if the
   * circuit is open and still cooling down — the caller should fail fast.
   * Otherwise transitions into `half-open` (from `open`) or leaves us in
   * `closed` and returns `'allow'`.
   */
  private _breakerPreCheck(): 'allow' | 'reject' {
    if (!this.breaker) return 'allow';
    if (this._state === 'closed') return 'allow';
    if (this._state === 'half-open') return 'allow';
    // Open — check recovery window.
    if (this._now() - this._openedAt >= this.breaker.recoveryMs) {
      this._transitionTo('half-open');
      return 'allow';
    }
    return 'reject';
  }

  private _recordSuccess(): void {
    if (!this.breaker) return;
    if (this._state === 'half-open') {
      this._transitionTo('closed');
    }
    this._consecutiveFailures = 0;
  }

  private _recordFailure(): void {
    if (!this.breaker) return;
    // Half-open failure re-opens the circuit immediately (one-strike rule).
    if (this._state === 'half-open') {
      this._openedAt = this._now();
      this._transitionTo('open');
      this._consecutiveFailures = 0;
      return;
    }
    this._consecutiveFailures += 1;
    if (
      this._state === 'closed' &&
      this._consecutiveFailures >= this.breaker.failureThreshold
    ) {
      this._openedAt = this._now();
      this._transitionTo('open');
    }
  }

  private _transitionTo(next: CircuitState): void {
    if (this._state === next) return;
    this._state = next;
    // Event naming matches the state: `circuit:<state>`. Tests assert the
    // sequence; callers can wire alerting / metrics to the same hook.
    this.emit(`circuit:${next}`);
  }

  // -------------------------------------------------------------------------
  // Internals — metrics
  // -------------------------------------------------------------------------

  private _emitMetrics(m: HttpMetrics): void {
    this.emit('metrics', m);
  }
}
