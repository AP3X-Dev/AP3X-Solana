import type { Signal } from './signal.js';
import type { SignalSource } from './source.js';

/**
 * Reported producer health. Consumed by external watchdogs, healthz endpoints,
 * and the bus itself for surfacing degraded sources.
 */
export interface ProducerHealth {
  ok: boolean;
  lastEmitAt?: Date;
  details?: Record<string, unknown>;
}

/**
 * A signal source dressed for multi-source dispatch. Producers identify
 * themselves with a stable {@link id}, declare which {@link source} transport
 * they ride on, the {@link signalType} they emit, and the
 * {@link signalVersion} of their schema/semantics. The bus routes by these
 * fields and enforces version pins from consumers.
 *
 * Compared to the lower-level {@link SignalSource} (which is an event-emitter
 * shape suited to a single transport adapter), `SignalProducer` is the unit
 * the bus knows about. Most existing transports plug in via {@link wrapSource}.
 */
export interface SignalProducer<S extends Signal = Signal> {
  readonly id: string;
  readonly source: string;
  readonly signalType: string;
  readonly signalVersion: string;
  /**
   * Begin emitting. The bus passes its own `emit` shim — the producer's
   * job is to call it for every signal it produces. The shim handles dedup,
   * version-pin enforcement, and consumer dispatch.
   */
  start(emit: (signal: S) => Promise<void>): Promise<void>;
  /** Stop emitting. Idempotent. */
  stop(): Promise<void>;
  /** Lightweight; safe on a hot path. */
  health(): ProducerHealth;
}

/**
 * A consumer of signals. Filters are applied in this order:
 *   1. {@link signalType} match (skip if specified and producer's type differs)
 *   2. {@link versionPin} match (reject if specified and signal.signalVersion differs)
 *   3. {@link filter} predicate (skip if returns false)
 *   4. {@link handle} called
 *
 * `handle` may throw — the bus catches and routes errors to a `handler-error`
 * event for dead-letter handling at the application layer.
 */
export interface SignalConsumer<S extends Signal = Signal> {
  readonly id: string;
  readonly signalType?: string;
  readonly versionPin?: string;
  filter?(s: S): boolean;
  handle(s: S): Promise<void>;
}

export interface Disposable {
  dispose(): void;
}

/**
 * Multi-source signal bus. Producers register; consumers register; the bus
 * fans signals from every producer out to every matching consumer. The bus
 * owns dedup, version-pin enforcement, and error routing.
 */
export interface SignalBus {
  registerProducer(p: SignalProducer): Disposable;
  registerConsumer(c: SignalConsumer): Disposable;
}

// ---------------------------------------------------------------------------
// wrapSource — adapter from event-emitter SignalSource to SignalProducer
// ---------------------------------------------------------------------------

export interface WrapSourceOpts {
  source: SignalSource;
  id: string;
  signalType: string;
  signalVersion: string;
}

/**
 * Adapter that turns an event-emitter-style {@link SignalSource} into a
 * {@link SignalProducer}. Stamps `signalVersion` on every emitted signal,
 * tracks `lastEmitAt`, and surfaces source `error`/`end` events as health
 * degradations. The source's `start(AbortSignal)` is invoked from the
 * producer's `start(emit)` so the bus's emit shim sees every signal.
 */
export function wrapSource(opts: WrapSourceOpts): SignalProducer {
  let lastEmitAt: Date | undefined;
  let ok = true;
  let started = false;
  let stopped = false;

  return {
    id: opts.id,
    source: opts.source.name,
    signalType: opts.signalType,
    signalVersion: opts.signalVersion,

    async start(emit) {
      if (started) return;
      started = true;
      stopped = false;

      opts.source.on('signal', (s: Signal) => {
        if (stopped) return;
        lastEmitAt = new Date();
        const stamped: Signal = s.signalVersion === undefined
          ? { ...s, signalVersion: opts.signalVersion }
          : s;
        // Fire-and-forget: the underlying source is event-emitter-driven
        // and cannot wait on a synchronous emit. Backpressure lives at the
        // bus's queue layer, not here.
        void emit(stamped);
      });

      opts.source.on('error', () => { ok = false; });
      opts.source.on('end',   () => { ok = false; });

      await opts.source.start();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      await opts.source.stop();
    },

    health() {
      const h: ProducerHealth = { ok };
      if (lastEmitAt) h.lastEmitAt = lastEmitAt;
      return h;
    },
  };
}
