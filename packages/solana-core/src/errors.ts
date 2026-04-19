/**
 * Structured error hierarchy for the AP3X Solana substrate.
 *
 * Per spec Section 3.1 every failure mode in the substrate is represented by
 * a concrete subclass of {@link Ap3xError}. String-only errors are explicitly
 * not allowed — every subclass carries a `code` (for log / metric tagging)
 * and a `meta` payload (for structured context).
 *
 * Design choices, called out:
 *
 *   - **`Ap3xError` is `abstract`.** Callers must pick a specific subclass —
 *     we never want a grab-bag `new Ap3xError(...)` that loses classification
 *     value at telemetry time. `abstract` enforces this at compile time;
 *     JavaScript doesn't honour `abstract` at runtime, but `code` is declared
 *     abstract which also blocks direct `new` on the narrowed type.
 *
 *   - **`code` is a namespaced string, stable across versions.** Single-word
 *     codes (`'decode'`, `'timeout'`, `'config'`) mark the subclass; for
 *     `RpcError` the code is further namespaced as `'rpc.<subcode>'` so every
 *     RPC failure class is uniquely tagged without needing to read `meta`.
 *
 *   - **`cause` uses the ES2022 `Error.cause` mechanism.** We call
 *     `super(message, options)` so the native Error captures cause and we
 *     don't need a shim. The field is declared explicitly for TS strictness.
 *
 *   - **No `toJSON()`.** Node's Error fields are non-enumerable by default
 *     (message, name, stack, cause). We don't override that — callers who
 *     need to serialize should pick fields explicitly, to avoid accidentally
 *     leaking stack traces or `cause` chains into structured logs.
 *
 *   - **Meta field types are strict.** `DecodingError.meta.expected` and
 *     `.actual` are REQUIRED per spec; `TimeoutError.meta.op`/`timeoutMs` and
 *     `ConfigError.meta.field` are required; everything else is optional.
 *
 *   - **Zero runtime deps.** No imports. `programId` / `accountKey` in
 *     `DecodingErrorMeta` are strings so callers may pass `pk.toBase58()`
 *     without creating a cycle back into {@link PublicKey}.
 */

/**
 * Abstract base class for all AP3X substrate errors.
 *
 * Extends the standard {@link Error}. The {@link code} field is declared
 * `abstract` to force every concrete subclass to pin a stable telemetry tag.
 * The {@link cause} field formalizes the ES2022 `Error.cause` option for TS
 * strict mode — the runtime behaviour is already provided by `Error` itself.
 */
export abstract class Ap3xError extends Error {
  /**
   * Stable, namespaced telemetry tag for this error class. Subclasses fix
   * this to a literal (e.g. `'decode'`) or a narrower string union (e.g.
   * `RpcError` sets it to \`rpc.${RpcErrorCode}\`).
   *
   * Intended for use as a log / metric label key — it is not a user-facing
   * string, so keep it short and stable across versions.
   */
  abstract readonly code: string;

  /**
   * Underlying cause, if any. Shape is `unknown` per the ES2022 spec — the
   * upstream failure may be an `Error`, a DOMException, or a bare value.
   *
   * `override` because the built-in `Error` in ES2022 already declares
   * `cause?: unknown`; this field re-declares it `readonly` for strictness.
   */
  override readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    // Pass `options` through so V8 captures `cause` on the built-in Error.
    // We also shadow `cause` as a TS-visible class field below so strict TS
    // can see it, and `name` gets set from the constructor name so stack
    // traces print "RpcError: ..." instead of "Error: ...".
    super(message, options);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// RpcError
// ---------------------------------------------------------------------------

/**
 * Sub-classification for {@link RpcError}. Every RPC failure the substrate
 * surfaces falls into one of these buckets — if a new category appears,
 * extend this union rather than cramming a message string.
 */
export type RpcErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'http'
  | 'rpc_method'
  | 'parse'
  | 'circuit_open';

/**
 * Structured metadata for {@link RpcError}. All fields optional because a
 * parse failure may not have a status code and a timeout may not have a
 * method name, etc. Concrete endpoints should populate whatever applies.
 */
export interface RpcErrorMeta {
  /** Endpoint URL, e.g. the Helius RPC that returned the error. */
  endpoint?: string;
  /** JSON-RPC method name, e.g. `'getSlot'`, when the failure is per-call. */
  method?: string;
  /** HTTP status code, when `http` transport failed. */
  statusCode?: number;
  /** JSON-RPC error code (`error.code` from the RPC envelope), when applicable. */
  rpcCode?: number;
  /** Suggested retry delay, when the upstream advertised one (e.g. 429). */
  retryAfterMs?: number;
}

/**
 * A failure originating from an RPC interaction — transport, rate limit,
 * timeout, method-level error, or response parsing.
 *
 * The `code` field is always `'rpc.<subcode>'` so a single string is enough
 * to identify the exact class in logs/metrics.
 */
export class RpcError extends Ap3xError {
  readonly code: `rpc.${RpcErrorCode}`;
  readonly meta: RpcErrorMeta;

  constructor(
    subCode: RpcErrorCode,
    message: string,
    meta: RpcErrorMeta = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = `rpc.${subCode}`;
    this.meta = meta;
  }
}

// ---------------------------------------------------------------------------
// DecodingError
// ---------------------------------------------------------------------------

/**
 * Structured metadata for {@link DecodingError}. `expected` and `actual` are
 * required — the whole point of a structured decoding failure is to explain
 * the mismatch in human-readable terms, per spec Section 3.1.
 */
export interface DecodingErrorMeta {
  /** Program ID this buffer was attributed to (base58), when known. */
  programId?: string;
  /** Account key the buffer was read from (base58), when known. */
  accountKey?: string;
  /** Offset at which the mismatch was detected. */
  byteOffset?: number;
  /** Human-readable description of what the decoder expected. */
  expected: string;
  /** Human-readable description of what it actually observed. */
  actual: string;
}

/**
 * A failure from parsing an on-chain account, instruction, or log payload.
 *
 * Thrown by the hand-rolled SPL / Metaplex / Borsh parsers — always includes
 * enough context (`programId`, `byteOffset`, `expected` vs `actual`) to
 * diagnose a discrepancy between our parser and a real on-chain account.
 */
export class DecodingError extends Ap3xError {
  readonly code = 'decode';
  readonly meta: DecodingErrorMeta;

  constructor(
    message: string,
    meta: DecodingErrorMeta,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.meta = meta;
  }
}

// ---------------------------------------------------------------------------
// TimeoutError
// ---------------------------------------------------------------------------

/**
 * Structured metadata for {@link TimeoutError}. Both fields required — a
 * timeout without `op` and `timeoutMs` is useless for alerting.
 */
export interface TimeoutErrorMeta {
  /** Name of the operation that timed out, e.g. `'connection.getSlot'`. */
  op: string;
  /** Timeout threshold in milliseconds that was exceeded. */
  timeoutMs: number;
}

/**
 * A generic timeout — used when an operation doesn't fit the RPC-specific
 * `RpcError('timeout', ...)` bucket (e.g. vault passphrase derivation,
 * Geyser subscription handshake).
 */
export class TimeoutError extends Ap3xError {
  readonly code = 'timeout';
  readonly meta: TimeoutErrorMeta;

  constructor(
    message: string,
    meta: TimeoutErrorMeta,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.meta = meta;
  }
}

// ---------------------------------------------------------------------------
// ConfigError
// ---------------------------------------------------------------------------

/**
 * Structured metadata for {@link ConfigError}. `field` is required so alerts
 * can be grouped by the exact config key that was wrong; `value` and `hint`
 * are optional because the offending value may be sensitive.
 */
export interface ConfigErrorMeta {
  /** Dotted path of the offending config field, e.g. `'rpc.primary.url'`. */
  field: string;
  /** Observed value — omit (or redact) if it may be sensitive. */
  value?: unknown;
  /** Remediation hint shown alongside the error message. */
  hint?: string;
}

/**
 * A failure caused by invalid or missing configuration — a bad cluster
 * selector, a malformed URL, an unknown fee tier name, etc. Always thrown
 * at startup / boundary; never during hot loops.
 */
export class ConfigError extends Ap3xError {
  readonly code = 'config';
  readonly meta: ConfigErrorMeta;

  constructor(
    message: string,
    meta: ConfigErrorMeta,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.meta = meta;
  }
}
