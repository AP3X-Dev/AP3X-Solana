/**
 * Substrate-wide metrics emitter.
 *
 * Every package in the AP3X Solana substrate — RPC pool, tx assembler, vault,
 * event decoders, verticals — fans telemetry out through ONE process-global
 * singleton `EventEmitter`. This module owns that singleton and the typed
 * helper (`emitMetric`) that all producers should use.
 *
 * Why a singleton:
 *
 *   - Observability wiring needs a single attach point. A substrate consumer
 *     (the `solana-watch` CLI, a user's trading bot) installs one listener on
 *     `metrics` and receives telemetry from every layer beneath. Injecting
 *     an emitter through every constructor is both more code and more
 *     coupling for a pure cross-cutting concern.
 *
 *   - Producers stay leaf-level: this module has no internal imports, so
 *     depending on it does not create cycles. `metrics.ts` is at the bottom
 *     of the substrate graph alongside `errors.ts`.
 *
 * Why `node:events`:
 *
 *   - Zero npm deps policy (see `CLAUDE.md`). `node:events` is in the Node
 *     standard library, pre-installed on every runtime we support, and has
 *     the `setMaxListeners` / `removeAllListeners` ergonomics we want.
 *
 * Caveat on singletons:
 *
 *   Shared-instance EventEmitters plus ESM can cause double-emit if the
 *   module is loaded twice (dual CJS+ESM bundles with misconfigured
 *   `exports` can land in this state). For this monorepo — one package,
 *   one process at a time, `type: "module"` + `tsup` producing a single ESM
 *   and single CJS entry that are never imported together — we accept the
 *   simplicity. No dedup. If dual-loading ever becomes a real issue we'd
 *   reach for a `globalThis.__ap3x_metrics__` registry here; not before.
 *
 * Event channel naming:
 *
 *   There is exactly one channel: `'metric'` (singular). All emissions flow
 *   through `emitMetric`, which stamps `ts` and emits on that channel. The
 *   HttpClient's local `'metrics'` (plural) event is a SEPARATE channel on
 *   a SEPARATE emitter — that is per-client, this is substrate-global.
 */

import { EventEmitter } from 'node:events';

/**
 * A single telemetry record. Produced by every substrate layer, consumed by
 * the observability wiring. Designed to be flat and JSON-stringifiable — no
 * class instances, no `Error` objects, no functions.
 *
 * Fields:
 *
 *   - `ts` — epoch milliseconds at the moment of emission. Callers may omit
 *     it; {@link emitMetric} fills it in with `Date.now()`. Subscribers ALWAYS
 *     see a populated `ts`.
 *   - `package` — npm package name of the producer, e.g. `'@ap3x/solana-core'`.
 *     The same literal string the package ships under; use exactly that.
 *   - `op` — dotted operation label, e.g. `'rpc.getAccountInfo'`,
 *     `'vault.unlock'`, `'tx.assemble'`. Keep stable across versions so
 *     dashboards don't break.
 *   - `latencyMs` — wall-clock latency of the operation, if measured.
 *   - `errorClass` — when the operation failed, the short classification tag
 *     (`'timeout'`, `'circuit_open'`, `'decode'`, …) — typically the same
 *     value as `Ap3xError.code`. Absent on success.
 *   - `meta` — free-form structured context. Must be shallow-serialisable.
 *     Do not store `Error` objects or circular references here; pick fields.
 */
export interface MetricEvent {
  ts: number;
  package: string;
  op: string;
  latencyMs?: number;
  errorClass?: string;
  meta?: Record<string, unknown>;
}

/**
 * Thin typed wrapper around {@link EventEmitter} for the `'metric'` channel.
 *
 * We subclass only to tighten `on`/`off`/`emit` signatures. The overloads
 * narrow the handler to `(ev: MetricEvent) => void` when the channel name is
 * `'metric'`; a fallback overload keeps the base-class-compatible shape so
 * consumers can still use `newListener` / `removeListener` / `error` etc.
 *
 * We deliberately do NOT model every EventEmitter method (once, prependListener,
 * etc.) — the base-class fallback covers them at the cost of slightly weaker
 * types on those paths. The hot path is `on` + `off` + `emit`.
 */
class MetricsEmitter extends EventEmitter {
  // The implementation signature uses `any[]` / `any` because TS requires it
  // to be compatible with every overload, and a typed-handler overload that
  // narrows `ev` to `MetricEvent` is not structurally assignable to a
  // `(...args: unknown[]) => void` impl. Using `any` in the IMPL only is a
  // deliberate, narrow escape hatch — callers never see it, they only see
  // the public overloads below it.
  override on(event: 'metric', handler: (ev: MetricEvent) => void): this;
  override on(event: string | symbol, handler: (...args: unknown[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, handler: (...args: any[]) => void): this {
    return super.on(event, handler);
  }

  override off(event: 'metric', handler: (ev: MetricEvent) => void): this;
  override off(event: string | symbol, handler: (...args: unknown[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override off(event: string | symbol, handler: (...args: any[]) => void): this {
    return super.off(event, handler);
  }

  override emit(event: 'metric', payload: MetricEvent): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * Process-global metrics emitter.
 *
 * `setMaxListeners(50)` — Node's default of 10 is tuned for a single app;
 * a multi-package substrate realistically attracts one listener per layer
 * (RPC pool, tx assembler, vault, each event decoder, the CLI wrapper, any
 * user-installed telemetry adapter). 50 is generous but not so high that a
 * real leak would be hidden.
 */
export const metrics: MetricsEmitter = new MetricsEmitter();
metrics.setMaxListeners(50);

/**
 * Emit a metric event on the shared {@link metrics} channel.
 *
 * Callers pass everything except `ts` — this helper stamps `ts = Date.now()`
 * when the caller didn't set it. Routing all emissions through `emitMetric`
 * (rather than `metrics.emit('metric', ...)` directly) guarantees:
 *
 *   1. `ts` is always populated on subscription.
 *   2. The channel name is spelled correctly (typos can't silently drop
 *      events onto a private channel).
 *   3. A future evolution of the payload — e.g. adding a `traceId` — has
 *      one place to change.
 *
 * Payload is emitted by reference; fan-out subscribers share the object.
 * Treat it as read-only.
 */
export function emitMetric(event: Omit<MetricEvent, 'ts'> & { ts?: number }): void {
  const payload: MetricEvent = {
    ...event,
    ts: event.ts ?? Date.now(),
  };
  metrics.emit('metric', payload);
}
