import { EventEmitter } from 'node:events';
import type { Signal } from './signal.js';

export interface SignalQueueOpts {
  capacity?: number;       // default 10_000
  dedupWindow?: number;    // default 5_000 (LRU size)
  dedupTtlMs?: number;     // default 600_000 (10 min)
}

type Handler = (s: Signal) => Promise<void> | void;

export class SignalQueue extends EventEmitter {
  private readonly capacity: number;
  private readonly dedupWindow: number;
  private readonly dedupTtlMs: number;
  private readonly buffer: Signal[] = [];
  private readonly subscribers = new Map<string, Handler>();
  private readonly dedup = new Map<string, number>(); // id → expiresAt
  private dispatching = false;

  constructor(opts: SignalQueueOpts = {}) {
    super();
    this.capacity = opts.capacity ?? 10_000;
    this.dedupWindow = opts.dedupWindow ?? 5_000;
    this.dedupTtlMs = opts.dedupTtlMs ?? 600_000;
  }

  subscribe(name: string, handler: Handler): void {
    this.subscribers.set(name, handler);
    void this.dispatch();
  }

  unsubscribe(name: string): void {
    this.subscribers.delete(name);
  }

  async push(signal: Signal): Promise<void> {
    this.evictExpiredDedup();
    if (this.dedup.has(signal.signalId)) {
      this.emit('drop', { reason: 'dup', signalId: signal.signalId });
      return;
    }
    this.dedup.set(signal.signalId, Date.now() + this.dedupTtlMs);
    if (this.dedup.size > this.dedupWindow) {
      const firstKey = this.dedup.keys().next().value;
      if (firstKey !== undefined) this.dedup.delete(firstKey);
    }

    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
      this.emit('overflow', { count: 1, since: Date.now() });
    }
    this.buffer.push(signal);
    void this.dispatch();
  }

  async drain(): Promise<void> {
    while (this.buffer.length > 0 && this.subscribers.size > 0) {
      await new Promise<void>((res) => setImmediate(res));
      await this.dispatch();
    }
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.buffer.length > 0 && this.subscribers.size > 0) {
        const sig = this.buffer.shift()!;
        for (const [name, handler] of this.subscribers) {
          try {
            await handler(sig);
          } catch (err) {
            this.emit('handler-error', { subscriber: name, error: err });
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  private evictExpiredDedup(): void {
    const now = Date.now();
    for (const [id, expires] of this.dedup) {
      if (expires <= now) this.dedup.delete(id);
      else break; // Map preserves insertion order; first non-expired ends the sweep
    }
  }
}
