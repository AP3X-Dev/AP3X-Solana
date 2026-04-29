import { EventEmitter } from 'node:events';
import type { Signal } from './signal.js';
import type {
  SignalProducer,
  SignalConsumer,
  SignalBus,
  Disposable,
} from './producer.js';

export interface SignalBusOpts {
  /** Dedup window size. Default 5_000. */
  dedupWindow?: number;
  /** Dedup entry TTL in ms. Default 600_000 (10 min). */
  dedupTtlMs?: number;
}

/**
 * Raised on the bus's `version-mismatch` event when a consumer pinned a
 * signalVersion and the producer's emitted signal carries a different one.
 * The signal is dropped for that consumer; other consumers (with no pin or
 * a matching pin) still receive it.
 */
export class VersionMismatchError extends Error {
  constructor(
    public readonly consumerId: string,
    public readonly producerId: string,
    public readonly consumerPin: string,
    public readonly producerVersion: string,
  ) {
    super(
      `Signal version mismatch: consumer "${consumerId}" pins "${consumerPin}"; ` +
      `producer "${producerId}" emits "${producerVersion}"`,
    );
    this.name = 'VersionMismatchError';
  }
}

interface RegisteredProducer {
  producer: SignalProducer;
}

interface RegisteredConsumer {
  consumer: SignalConsumer;
}

/**
 * In-memory implementation of {@link SignalBus}. Suited for single-process
 * agent runtimes. For multi-process coordination, consumers compose this with
 * an external broker (Redis, NATS) at the application layer.
 *
 * Events emitted (via Node EventEmitter):
 *   - `dropped`           { reason: 'dup', signalId } — dedup short-circuit
 *   - `version-mismatch`  VersionMismatchError       — consumer's pin rejected the signal
 *   - `handler-error`     { consumerId, error, signal } — consumer.handle threw
 *   - `producer-error`    { producerId, error }      — producer.start threw
 */
export class MemorySignalBus extends EventEmitter implements SignalBus {
  private readonly producers = new Map<string, RegisteredProducer>();
  private readonly consumers = new Map<string, RegisteredConsumer>();
  private readonly dedup = new Map<string, number>();
  private readonly dedupTtlMs: number;
  private readonly dedupWindow: number;
  private closed = false;

  constructor(opts: SignalBusOpts = {}) {
    super();
    this.dedupTtlMs = opts.dedupTtlMs ?? 600_000;
    this.dedupWindow = opts.dedupWindow ?? 5_000;
  }

  registerProducer(producer: SignalProducer): Disposable {
    if (this.closed) throw new Error('SignalBus is closed');
    if (this.producers.has(producer.id)) {
      throw new Error(`Producer with id "${producer.id}" is already registered`);
    }
    this.producers.set(producer.id, { producer });

    // emit shim — handed to the producer's start(). Encapsulates dedup,
    // version-pin enforcement, and per-consumer dispatch.
    const emit = async (signal: Signal): Promise<void> => {
      if (this.closed) return;

      // Dedup on signalId.
      this.evictExpiredDedup();
      if (this.dedup.has(signal.signalId)) {
        this.emit('dropped', { reason: 'dup', signalId: signal.signalId });
        return;
      }
      this.dedup.set(signal.signalId, Date.now() + this.dedupTtlMs);
      if (this.dedup.size > this.dedupWindow) {
        const firstKey = this.dedup.keys().next().value;
        if (firstKey !== undefined) this.dedup.delete(firstKey);
      }

      // Stamp version if the producer didn't (defensive — wrapSource stamps it,
      // but a hand-rolled producer might not).
      const stamped: Signal = signal.signalVersion === undefined
        ? { ...signal, signalVersion: producer.signalVersion }
        : signal;

      // Dispatch.
      for (const { consumer } of this.consumers.values()) {
        if (consumer.signalType && consumer.signalType !== producer.signalType) continue;

        if (
          consumer.versionPin !== undefined &&
          consumer.versionPin !== stamped.signalVersion
        ) {
          this.emit(
            'version-mismatch',
            new VersionMismatchError(
              consumer.id,
              producer.id,
              consumer.versionPin,
              stamped.signalVersion ?? '',
            ),
          );
          continue;
        }

        if (consumer.filter && !consumer.filter(stamped)) continue;

        try {
          await consumer.handle(stamped);
        } catch (err) {
          this.emit('handler-error', { consumerId: consumer.id, error: err, signal: stamped });
        }
      }
    };

    // Defer producer.start so the caller can register consumers immediately
    // after registering a producer without racing the first emission.
    queueMicrotask(() => {
      if (this.closed) return;
      if (!this.producers.has(producer.id)) return; // disposed before start ran
      void producer.start(emit).catch((err) => {
        this.emit('producer-error', { producerId: producer.id, error: err });
      });
    });

    return {
      dispose: () => {
        const rec = this.producers.get(producer.id);
        if (!rec) return;
        this.producers.delete(producer.id);
        void rec.producer.stop().catch(() => {});
      },
    };
  }

  registerConsumer(consumer: SignalConsumer): Disposable {
    if (this.closed) throw new Error('SignalBus is closed');
    if (this.consumers.has(consumer.id)) {
      throw new Error(`Consumer with id "${consumer.id}" is already registered`);
    }
    this.consumers.set(consumer.id, { consumer });
    return {
      dispose: () => { this.consumers.delete(consumer.id); },
    };
  }

  /** Stop every registered producer; clear all state. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stops: Array<Promise<void>> = [];
    for (const { producer } of this.producers.values()) {
      stops.push(producer.stop().catch(() => undefined as void));
    }
    await Promise.allSettled(stops);
    this.producers.clear();
    this.consumers.clear();
    this.dedup.clear();
  }

  /** Snapshot of currently-registered producers. Read-only. */
  listProducers(): ReadonlyArray<SignalProducer> {
    return [...this.producers.values()].map((r) => r.producer);
  }

  /** Snapshot of currently-registered consumers. Read-only. */
  listConsumers(): ReadonlyArray<SignalConsumer> {
    return [...this.consumers.values()].map((r) => r.consumer);
  }

  private evictExpiredDedup(): void {
    const now = Date.now();
    for (const [id, expires] of this.dedup) {
      if (expires <= now) this.dedup.delete(id);
      else break; // Map preserves insertion order
    }
  }
}
