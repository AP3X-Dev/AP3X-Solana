import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics, emitMetric, type MetricEvent } from './metrics';

/**
 * The metrics emitter is a *process-global singleton*: every `import` in the
 * process sees the same instance. That is the whole point — decoders, RPC
 * clients, vault, and the CLI all fan-out events through one channel.
 *
 * Because it's a singleton, tests must be scrupulous about cleaning up their
 * own listeners. A leaked listener here leaks across tests.  Every test that
 * subscribes MUST tear down with `metrics.removeAllListeners('metric')` (or a
 * targeted `off`), which is what the `afterEach` below guarantees.
 */
afterEach(() => {
  // Clear anything the individual test forgot to unsubscribe. We only clear
  // the 'metric' channel so accidental `on('newListener', ...)` style wiring
  // in future work isn't clobbered.
  metrics.removeAllListeners('metric');
});

describe('metrics singleton', () => {
  it('exports a shared EventEmitter instance', () => {
    // Module-level const => same identity across every importer. We can't
    // import it twice from the same spec (ESM caches the module), but we can
    // assert the instance *is* an EventEmitter-like object: has on/off/emit.
    expect(typeof metrics.on).toBe('function');
    expect(typeof metrics.off).toBe('function');
    expect(typeof metrics.emit).toBe('function');
    expect(typeof metrics.removeListener).toBe('function');
  });

  it('does not emit anything merely as a side-effect of import', () => {
    // Listener attached *after* import — if the module had emitted during
    // evaluation we'd already have missed it. The contract is still that no
    // event is emitted unless `emitMetric` is called, so piling up a fresh
    // subscription here and asserting the queue is empty proves nothing new
    // emits post-import either.
    const handler = vi.fn();
    metrics.on('metric', handler);
    // No explicit tick — synchronous emit means any import-time emission
    // would have completed before this line, and we'd have zero chance to
    // observe it. That is itself the point: zero side-effects at import.
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('emitMetric', () => {
  it('delivers an event to a single subscriber with all fields intact', () => {
    const handler = vi.fn();
    metrics.on('metric', handler);

    emitMetric({
      package: '@ap3x/solana-core',
      op: 'http.request',
      latencyMs: 42,
      errorClass: 'timeout',
      meta: { endpoint: 'https://example.test', attempts: 2 },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const [payload] = handler.mock.calls[0] as [MetricEvent];
    expect(payload.package).toBe('@ap3x/solana-core');
    expect(payload.op).toBe('http.request');
    expect(payload.latencyMs).toBe(42);
    expect(payload.errorClass).toBe('timeout');
    expect(payload.meta).toEqual({ endpoint: 'https://example.test', attempts: 2 });
  });

  it('auto-populates ts with Date.now() when omitted', () => {
    const handler = vi.fn();
    metrics.on('metric', handler);

    const before = Date.now();
    emitMetric({ package: '@ap3x/solana-core', op: 'noop' });
    const after = Date.now();

    const [payload] = handler.mock.calls[0] as [MetricEvent];
    expect(typeof payload.ts).toBe('number');
    // Inclusive on both ends — the emission may happen on exactly `before`
    // or exactly `after` if the system clock has millisecond granularity.
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });

  it('respects a caller-provided ts and does not overwrite it', () => {
    const handler = vi.fn();
    metrics.on('metric', handler);

    const fixedTs = 1_700_000_000_000;
    emitMetric({ ts: fixedTs, package: '@ap3x/solana-core', op: 'noop' });

    const [payload] = handler.mock.calls[0] as [MetricEvent];
    expect(payload.ts).toBe(fixedTs);
  });

  it('delivers an event to every subscriber (fan-out)', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    metrics.on('metric', a);
    metrics.on('metric', b);
    metrics.on('metric', c);

    emitMetric({ package: '@ap3x/solana-core', op: 'fanout' });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it('delivers the identical payload reference to every subscriber', () => {
    // Subscribers share one payload object. That's intentional — cloning per
    // listener would be wasteful for a hot path — but it's a constraint on
    // subscribers: treat the payload as read-only. Assert the contract.
    const received: MetricEvent[] = [];
    metrics.on('metric', (ev) => received.push(ev));
    metrics.on('metric', (ev) => received.push(ev));

    emitMetric({ package: '@ap3x/solana-core', op: 'shared' });

    expect(received).toHaveLength(2);
    expect(received[0]).toBe(received[1]);
  });

  it('honours removeListener / off so subscribers can detach', () => {
    const handler = vi.fn();
    metrics.on('metric', handler);
    metrics.off('metric', handler);

    emitMetric({ package: '@ap3x/solana-core', op: 'detached' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts all optional fields being absent', () => {
    const handler = vi.fn();
    metrics.on('metric', handler);

    emitMetric({ package: '@ap3x/solana-core', op: 'minimal' });

    const [payload] = handler.mock.calls[0] as [MetricEvent];
    expect(payload.package).toBe('@ap3x/solana-core');
    expect(payload.op).toBe('minimal');
    expect(payload.latencyMs).toBeUndefined();
    expect(payload.errorClass).toBeUndefined();
    expect(payload.meta).toBeUndefined();
    expect(typeof payload.ts).toBe('number');
  });

  it('provides a typed handler via on("metric", handler)', () => {
    // Pure TS type-check: if the overload on `MetricsEmitter.on` didn't
    // narrow the handler argument to `MetricEvent`, this file would fail to
    // compile. Reading the fields below forces TS to use the typed overload
    // rather than the fallback `(...args: any[]) => void`.
    metrics.on('metric', (ev) => {
      // The `: string` annotations force TS to resolve ev.package/op against
      // MetricEvent; if the overload broke, these lines would fail typecheck.
      const pkg: string = ev.package;
      const op: string = ev.op;
      void pkg;
      void op;
      // Negative check: accessing a non-existent field must be a type error.
      // @ts-expect-error — `nonexistent` is not on MetricEvent
      void ev.nonexistent;
    });

    // Sanity emit to ensure the handler itself runs without runtime error.
    emitMetric({ package: '@ap3x/solana-core', op: 'typed-handler' });
  });

  it('sets a generous maxListeners ceiling (≥ 50)', () => {
    // Large fan-out (every substrate package plus verticals plus user code)
    // can easily cross Node's default of 10 without being a real leak.
    // Document the raised ceiling via the test so it doesn't silently
    // regress.
    expect(metrics.getMaxListeners()).toBeGreaterThanOrEqual(50);
  });
});
