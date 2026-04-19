import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import { HttpClient, type HttpMetrics } from './http-client';
import { RpcError, TimeoutError } from './errors';

// ---------------------------------------------------------------------------
// msw server bootstrap
// ---------------------------------------------------------------------------
//
// All tests hit the fake origin `http://test.local`. Each test installs its
// own handlers via `server.use(...)`, so resets are important.
// ---------------------------------------------------------------------------

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers — injectable clock + deterministic delay + deterministic jitter
// ---------------------------------------------------------------------------

function mkClock(start = 0) {
  const state = { now: start };
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
    },
    set: (ms: number) => {
      state.now = ms;
    },
  };
}

function mkDelayRecorder() {
  const delays: number[] = [];
  const delay = async (ms: number) => {
    delays.push(ms);
  };
  return { delay, delays };
}

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

describe('HttpClient — constructor defaults', () => {
  it('constructs with only timeoutMs set', () => {
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    expect(c).toBeInstanceOf(HttpClient);
  });

  it('no retry config means attempts=1 (single attempt, no retries)', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/x', () => {
        hits += 1;
        return new HttpResponse('fail', { status: 500 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    await expect(c.get('/x')).rejects.toBeInstanceOf(RpcError);
    expect(hits).toBe(1);
  });

  it('no circuitBreaker config means the breaker never opens', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/y', () => {
        hits += 1;
        return new HttpResponse('fail', { status: 500 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    // 10 failures, all should actually attempt the network.
    for (let i = 0; i < 10; i++) {
      await expect(c.get('/y')).rejects.toBeInstanceOf(RpcError);
    }
    expect(hits).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe('HttpClient — success paths', () => {
  it('get returns the Response on 200', async () => {
    server.use(
      http.get('http://test.local/ok', () =>
        HttpResponse.json({ hello: 'world' }, { status: 200 }),
      ),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    const res = await c.get('/ok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  it('post JSON-serializes an object body and sets Content-Type', async () => {
    let captured: { ct?: string | null; body?: unknown } = {};
    server.use(
      http.post('http://test.local/echo', async ({ request }) => {
        captured.ct = request.headers.get('content-type');
        captured.body = await request.json();
        return HttpResponse.json({ ok: true }, { status: 200 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    const res = await c.post('/echo', { jsonrpc: '2.0', method: 'getSlot', id: 1 });
    expect(res.status).toBe(200);
    expect(captured.ct).toContain('application/json');
    expect(captured.body).toEqual({ jsonrpc: '2.0', method: 'getSlot', id: 1 });
  });

  it('post passes string body through unchanged (no auto-JSON)', async () => {
    let captured: { ct?: string | null; text?: string } = {};
    server.use(
      http.post('http://test.local/raw', async ({ request }) => {
        captured.ct = request.headers.get('content-type');
        captured.text = await request.text();
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    await c.post('/raw', 'raw-payload');
    // No Content-Type auto-set when body is already a string.
    expect(captured.ct).not.toContain('application/json');
    expect(captured.text).toBe('raw-payload');
  });

  it('post passes Uint8Array body through unchanged', async () => {
    let captured: { ct?: string | null; len?: number } = {};
    server.use(
      http.post('http://test.local/bin', async ({ request }) => {
        captured.ct = request.headers.get('content-type');
        const buf = await request.arrayBuffer();
        captured.len = buf.byteLength;
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    await c.post('/bin', new Uint8Array([1, 2, 3, 4]));
    expect(captured.len).toBe(4);
  });

  it('request with absolute URL ignores baseUrl', async () => {
    server.use(
      http.get('http://other.local/x', () => new HttpResponse('ok', { status: 200 })),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    const res = await c.request('GET', 'http://other.local/x');
    expect(res.status).toBe(200);
  });

  it('handles baseUrl with trailing slash + path with leading slash', async () => {
    server.use(
      http.get('http://test.local/a/b', () => new HttpResponse('ok', { status: 200 })),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local/' });
    const res = await c.get('/a/b');
    expect(res.status).toBe(200);
  });

  it('handles baseUrl without trailing slash + path without leading slash', async () => {
    server.use(
      http.get('http://test.local/c/d', () => new HttpResponse('ok', { status: 200 })),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    const res = await c.request('GET', 'c/d');
    expect(res.status).toBe(200);
  });

  it('requests with no baseUrl require an absolute path', async () => {
    server.use(
      http.get('http://test.local/e', () => new HttpResponse('ok', { status: 200 })),
    );
    const c = new HttpClient({ timeoutMs: 1_000 });
    const res = await c.request('GET', 'http://test.local/e');
    expect(res.status).toBe(200);
  });

  it('post with undefined body omits body entirely', async () => {
    let captured: { hasBody?: boolean } = {};
    server.use(
      http.post('http://test.local/nobody', async ({ request }) => {
        const txt = await request.text();
        captured.hasBody = txt.length > 0;
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    await c.post('/nobody', undefined);
    expect(captured.hasBody).toBe(false);
  });

  it('post preserves caller-set Content-Type for object bodies', async () => {
    let captured: { ct?: string | null } = {};
    server.use(
      http.post('http://test.local/customct', async ({ request }) => {
        captured.ct = request.headers.get('content-type');
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    await c.post('/customct', { x: 1 }, { headers: { 'content-type': 'application/vnd.custom+json' } });
    expect(captured.ct).toBe('application/vnd.custom+json');
  });
});

// ---------------------------------------------------------------------------
// Retry behaviour
// ---------------------------------------------------------------------------

describe('HttpClient — retry', () => {
  it('retries on 5xx and returns final 200', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/flaky', () => {
        hits += 1;
        if (hits < 3) return new HttpResponse('nope', { status: 503 });
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 3, backoffMs: 10, jitter: 0 },
      delay: d.delay,
      random: () => 0,
    });
    const res = await c.get('/flaky');
    expect(res.status).toBe(200);
    expect(hits).toBe(3);
    // 2 sleeps between the 3 attempts.
    expect(d.delays.length).toBe(2);
    expect(d.delays[0]).toBe(10); // 10 * 2^0
    expect(d.delays[1]).toBe(20); // 10 * 2^1
  });

  it('retries on network error then succeeds', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/netfail', () => {
        hits += 1;
        if (hits < 2) return HttpResponse.error();
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 3, backoffMs: 5, jitter: 0 },
      delay: d.delay,
      random: () => 0,
    });
    const res = await c.get('/netfail');
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
  });

  it('exhausts retries and throws RpcError with last status code', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/dead', () => {
        hits += 1;
        return new HttpResponse('boom', { status: 500 });
      }),
    );
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 2, backoffMs: 1, jitter: 0 },
      delay: d.delay,
      random: () => 0,
    });
    await expect(c.get('/dead')).rejects.toMatchObject({
      code: 'rpc.http',
      meta: expect.objectContaining({ statusCode: 500 }),
    });
    expect(hits).toBe(2);
  });

  it('does not retry on 4xx (except 429)', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/nope', () => {
        hits += 1;
        return new HttpResponse('not found', { status: 404 });
      }),
    );
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 3, backoffMs: 1, jitter: 0 },
      delay: d.delay,
      random: () => 0,
    });
    await expect(c.get('/nope')).rejects.toMatchObject({
      code: 'rpc.http',
      meta: expect.objectContaining({ statusCode: 404 }),
    });
    expect(hits).toBe(1);
    expect(d.delays.length).toBe(0);
  });

  it('retries on 429 (rate limited)', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/slow', () => {
        hits += 1;
        if (hits < 2) return new HttpResponse('slow down', { status: 429 });
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 3, backoffMs: 1, jitter: 0 },
      delay: d.delay,
      random: () => 0,
    });
    const res = await c.get('/slow');
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
  });

  it('honors Retry-After header on 429 (seconds form)', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/throttled', () => {
        hits += 1;
        if (hits < 2) {
          return new HttpResponse('slow down', {
            status: 429,
            headers: { 'retry-after': '2' },
          });
        }
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 3, backoffMs: 1, jitter: 0 },
      delay: d.delay,
      random: () => 0,
    });
    await c.get('/throttled');
    // "2" seconds → 2000ms overrides the computed backoff (1ms)
    expect(d.delays[0]).toBe(2000);
  });

  it('exhausted 429 retries throw RpcError with code rpc.rate_limited', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/still-throttled', () => {
        hits += 1;
        return new HttpResponse('nope', { status: 429 });
      }),
    );
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 2, backoffMs: 1, jitter: 0 },
      delay: d.delay,
      random: () => 0,
    });
    // A persistent 429 is a rate-limit problem, not a generic HTTP failure —
    // callers filtering on `.code` can react specifically.
    await expect(c.get('/still-throttled')).rejects.toMatchObject({
      code: 'rpc.rate_limited',
      meta: expect.objectContaining({ statusCode: 429 }),
    });
    expect(hits).toBe(2);
  });

  it('applies multiplicative jitter: delay * (1 + random() * jitter)', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/j', () => {
        hits += 1;
        if (hits < 2) return new HttpResponse('x', { status: 500 });
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 3, backoffMs: 100, jitter: 0.5 },
      delay: d.delay,
      random: () => 1.0, // max jitter
    });
    await c.get('/j');
    // 100 * 2^0 * (1 + 1 * 0.5) = 150
    expect(d.delays[0]).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('HttpClient — timeout', () => {
  it('aborts after timeoutMs and throws TimeoutError', async () => {
    server.use(
      http.get('http://test.local/hang', async () => {
        // Never resolve — msw will respect fetch abort signal.
        await new Promise(() => {});
        return new HttpResponse('never', { status: 200 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 20, baseUrl: 'http://test.local' });
    await expect(c.get('/hang')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('composes caller AbortSignal with internal timeout', async () => {
    server.use(
      http.get('http://test.local/hang2', async () => {
        await new Promise(() => {});
        return new HttpResponse('x', { status: 200 });
      }),
    );
    const c = new HttpClient({ timeoutMs: 10_000, baseUrl: 'http://test.local' });
    const ctrl = new AbortController();
    const p = c.get('/hang2', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    // Caller-driven abort must NOT surface as a TimeoutError — the internal
    // timeout of 10s has nowhere near elapsed, and the caller's signal won.
    // The propagated error should look like a native AbortError (DOMException
    // with `.name === 'AbortError'`), not our TimeoutError wrapper.
    const caught = await p.catch((e) => e);
    expect(caught).not.toBeInstanceOf(TimeoutError);
    expect((caught as { name?: string }).name).toBe('AbortError');
  });

  // -------------------------------------------------------------------------
  // Listener-leak regression: the fallback compose path (used when
  // AbortSignal.any is unavailable) adds a listener to the caller's signal
  // via `{ once: true }`. That only auto-removes if the caller *actually*
  // aborts — on the happy path the listener would persist. Caller signals
  // are commonly shared across many requests, so a leak here grows the
  // listener count unboundedly.
  //
  // We patch the runtime AbortSignal.any to undefined for this test to force
  // the fallback path, then assert listeners added during fetch are removed
  // afterwards.
  // -------------------------------------------------------------------------

  it('does not leak caller-signal listeners across many successful requests', async () => {
    server.use(
      http.get('http://test.local/leak', () => new HttpResponse('ok', { status: 200 })),
    );
    // Force the fallback compose path regardless of Node version.
    const originalAny = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
      const ctrl = new AbortController();

      // Spy on add/remove to confirm each add is paired with a remove.
      let adds = 0;
      let removes = 0;
      type AnyListener = (...args: unknown[]) => unknown;
      const signal = ctrl.signal as unknown as {
        addEventListener: (t: string, l: AnyListener, o?: unknown) => void;
        removeEventListener: (t: string, l: AnyListener, o?: unknown) => void;
      };
      const origAdd = signal.addEventListener.bind(signal);
      const origRemove = signal.removeEventListener.bind(signal);
      signal.addEventListener = (t, l, o) => {
        if (t === 'abort') adds += 1;
        return origAdd(t, l, o);
      };
      signal.removeEventListener = (t, l, o) => {
        if (t === 'abort') removes += 1;
        return origRemove(t, l, o);
      };

      for (let i = 0; i < 20; i++) {
        const res = await c.get('/leak', { signal: ctrl.signal });
        expect(res.status).toBe(200);
      }

      // Every add should be matched by a remove — no net listener growth.
      expect(adds).toBe(20);
      expect(removes).toBe(20);
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = originalAny;
    }
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe('HttpClient — circuit breaker', () => {
  it('opens after failureThreshold consecutive failures', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/cb1', () => {
        hits += 1;
        return new HttpResponse('x', { status: 500 });
      }),
    );
    const d = mkDelayRecorder();
    const clock = mkClock(1000);
    const states: string[] = [];
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      circuitBreaker: { failureThreshold: 2, recoveryMs: 1_000 },
      now: clock.now,
      delay: d.delay,
      random: () => 0,
    });
    c.on('circuit:open', () => states.push('open'));
    await expect(c.get('/cb1')).rejects.toBeDefined();
    await expect(c.get('/cb1')).rejects.toBeDefined();
    // Third call — circuit should be open, no server hit.
    await expect(c.get('/cb1')).rejects.toMatchObject({
      code: 'rpc.circuit_open',
      message: expect.stringContaining('circuit'),
    });
    expect(hits).toBe(2);
    expect(states).toEqual(['open']);
  });

  it('half-opens after recoveryMs and closes on success', async () => {
    let hits = 0;
    let failMode = true;
    server.use(
      http.get('http://test.local/cb2', () => {
        hits += 1;
        if (failMode) return new HttpResponse('x', { status: 500 });
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const clock = mkClock(1000);
    const d = mkDelayRecorder();
    const states: string[] = [];
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      circuitBreaker: { failureThreshold: 2, recoveryMs: 500 },
      now: clock.now,
      delay: d.delay,
      random: () => 0,
    });
    c.on('circuit:open', () => states.push('open'));
    c.on('circuit:half-open', () => states.push('half-open'));
    c.on('circuit:closed', () => states.push('closed'));

    await expect(c.get('/cb2')).rejects.toBeDefined();
    await expect(c.get('/cb2')).rejects.toBeDefined();
    // Circuit is open.
    await expect(c.get('/cb2')).rejects.toMatchObject({
      message: expect.stringContaining('circuit'),
    });
    expect(hits).toBe(2);

    // Advance past recovery window; flip server to succeed.
    clock.advance(600);
    failMode = false;

    const res = await c.get('/cb2');
    expect(res.status).toBe(200);
    expect(hits).toBe(3);
    expect(states).toEqual(['open', 'half-open', 'closed']);
  });

  it('half-open failure re-opens the circuit', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/cb3', () => {
        hits += 1;
        return new HttpResponse('x', { status: 500 });
      }),
    );
    const clock = mkClock(1000);
    const d = mkDelayRecorder();
    const states: string[] = [];
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      circuitBreaker: { failureThreshold: 2, recoveryMs: 500 },
      now: clock.now,
      delay: d.delay,
      random: () => 0,
    });
    c.on('circuit:open', () => states.push('open'));
    c.on('circuit:half-open', () => states.push('half-open'));

    await expect(c.get('/cb3')).rejects.toBeDefined();
    await expect(c.get('/cb3')).rejects.toBeDefined();
    clock.advance(600);
    // half-open, one attempt, fails → re-opens.
    await expect(c.get('/cb3')).rejects.toBeDefined();
    expect(hits).toBe(3);
    expect(states).toEqual(['open', 'half-open', 'open']);

    // Immediately after re-open, a follow-up call is rejected without a hit.
    await expect(c.get('/cb3')).rejects.toMatchObject({
      message: expect.stringContaining('circuit'),
    });
    expect(hits).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Half-open concurrency — only ONE probe may be in flight at a time.
  // -------------------------------------------------------------------------
  //
  // `HttpClient` is shared across the RPC pool, so two concurrent callers can
  // both observe the half-open state. Without the `_inflightHalfOpenProbe`
  // guard, both would pass `_breakerPreCheck` and hit the network, violating
  // the one-probe rule.

  it('rejects concurrent half-open probe with circuit-open error', async () => {
    let hits = 0;
    // A latch we can release manually so the first probe holds the slot while
    // a second request arrives.
    let releaseFirst!: (r: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    server.use(
      http.get('http://test.local/cbc1', async () => {
        hits += 1;
        // Only the first (probe) request awaits the latch; subsequent ones
        // never reach here because the circuit should reject them.
        return await firstResponse;
      }),
    );
    const clock = mkClock(1000);
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 5_000,
      baseUrl: 'http://test.local',
      circuitBreaker: { failureThreshold: 2, recoveryMs: 500 },
      now: clock.now,
      delay: d.delay,
      random: () => 0,
    });
    // Force the breaker into `open` first.
    server.use(
      http.get('http://test.local/seed', () => new HttpResponse('x', { status: 500 })),
    );
    await expect(c.get('/seed')).rejects.toBeDefined();
    await expect(c.get('/seed')).rejects.toBeDefined();
    // Advance past recovery so the next call will transition open → half-open.
    clock.advance(600);

    // Kick off the probe (hits the latched handler, stays in flight).
    const probePromise = c.get('/cbc1');
    // Give the microtask queue one tick so the probe enters `_fetchOnce` and
    // the inflight flag is set.
    await Promise.resolve();
    await Promise.resolve();

    // A second caller while the probe is in flight must be rejected by the
    // circuit — no additional server hit.
    await expect(c.get('/cbc1')).rejects.toMatchObject({
      code: 'rpc.circuit_open',
      message: expect.stringContaining('circuit'),
    });
    expect(hits).toBe(1);

    // Now release the probe with a success so the test can finish cleanly.
    releaseFirst(new HttpResponse('ok', { status: 200 }));
    const res = await probePromise;
    expect(res.status).toBe(200);
    expect(hits).toBe(1);
  });

  it('half-open probe success closes the circuit and clears the inflight flag', async () => {
    let hits = 0;
    let failMode = true;
    server.use(
      http.get('http://test.local/cbc2', () => {
        hits += 1;
        if (failMode) return new HttpResponse('x', { status: 500 });
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const clock = mkClock(1000);
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      circuitBreaker: { failureThreshold: 2, recoveryMs: 500 },
      now: clock.now,
      delay: d.delay,
      random: () => 0,
    });
    // Open the breaker.
    await expect(c.get('/cbc2')).rejects.toBeDefined();
    await expect(c.get('/cbc2')).rejects.toBeDefined();
    clock.advance(600);
    failMode = false;

    // Successful probe (closes the circuit).
    expect((await c.get('/cbc2')).status).toBe(200);
    // Inflight flag must be cleared now — subsequent requests proceed normally
    // in the `closed` state. Fire a few and assert they all hit the server.
    for (let i = 0; i < 3; i++) {
      expect((await c.get('/cbc2')).status).toBe(200);
    }
    // 2 initial failures + 1 probe + 3 follow-ups = 6 server hits.
    expect(hits).toBe(6);
  });

  it('circuit-open rejection throws RpcError with code rpc.circuit_open', async () => {
    server.use(
      http.get('http://test.local/cbcode', () => new HttpResponse('x', { status: 500 })),
    );
    const clock = mkClock(0);
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      circuitBreaker: { failureThreshold: 1, recoveryMs: 10_000 },
      now: clock.now,
      delay: d.delay,
      random: () => 0,
    });
    // One failure opens the circuit.
    await expect(c.get('/cbcode')).rejects.toMatchObject({ code: 'rpc.http' });
    // Next call is rejected by the breaker with a distinct `rpc.circuit_open`
    // code — this is what lets callers distinguish a short-circuit from a
    // genuine HTTP failure without poking at `.meta`.
    const err = await c.get('/cbcode').catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe('rpc.circuit_open');
    expect((err as RpcError).meta.endpoint).toBe('/cbcode');
  });

  it('half-open probe failure re-opens and clears the inflight flag', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/cbc3', () => {
        hits += 1;
        return new HttpResponse('x', { status: 500 });
      }),
    );
    const clock = mkClock(1000);
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      circuitBreaker: { failureThreshold: 2, recoveryMs: 500 },
      now: clock.now,
      delay: d.delay,
      random: () => 0,
    });
    // Open the breaker.
    await expect(c.get('/cbc3')).rejects.toBeDefined();
    await expect(c.get('/cbc3')).rejects.toBeDefined();
    clock.advance(600);

    // Probe fails → circuit re-opens, inflight cleared.
    await expect(c.get('/cbc3')).rejects.toBeDefined();
    expect(hits).toBe(3);

    // Subsequent request should get the normal open-state rejection, not be
    // stuck because of a leaked inflight flag. No network hit expected.
    await expect(c.get('/cbc3')).rejects.toMatchObject({
      code: 'rpc.circuit_open',
      message: expect.stringContaining('circuit'),
    });
    expect(hits).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Metrics emission
// ---------------------------------------------------------------------------

describe('HttpClient — metrics events', () => {
  it('emits metrics with statusCode + retryCount=0 on first-try success', async () => {
    server.use(
      http.get('http://test.local/m1', () => new HttpResponse('ok', { status: 200 })),
    );
    const events: HttpMetrics[] = [];
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    c.on('metrics', (m: HttpMetrics) => events.push(m));
    await c.get('/m1');
    expect(events.length).toBe(1);
    expect(events[0]!.statusCode).toBe(200);
    expect(events[0]!.retryCount).toBe(0);
    expect(events[0]!.errorClass).toBeUndefined();
    expect(typeof events[0]!.latencyMs).toBe('number');
  });

  it('emits metrics with errorClass=timeout on timeout', async () => {
    server.use(
      http.get('http://test.local/m2', async () => {
        await new Promise(() => {});
        return new HttpResponse('x', { status: 200 });
      }),
    );
    const events: HttpMetrics[] = [];
    const c = new HttpClient({ timeoutMs: 20, baseUrl: 'http://test.local' });
    c.on('metrics', (m: HttpMetrics) => events.push(m));
    await expect(c.get('/m2')).rejects.toBeInstanceOf(TimeoutError);
    expect(events.length).toBe(1);
    expect(events[0]!.errorClass).toBe('timeout');
    expect(events[0]!.statusCode).toBeUndefined();
  });

  it('emits metrics with errorClass=network on network failure', async () => {
    server.use(http.get('http://test.local/m3', () => HttpResponse.error()));
    const events: HttpMetrics[] = [];
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    c.on('metrics', (m: HttpMetrics) => events.push(m));
    await expect(c.get('/m3')).rejects.toBeDefined();
    expect(events.length).toBe(1);
    expect(events[0]!.errorClass).toBe('network');
  });

  it('emits metrics with errorClass=http on non-retryable 4xx', async () => {
    server.use(
      http.get('http://test.local/m4', () => new HttpResponse('x', { status: 404 })),
    );
    const events: HttpMetrics[] = [];
    const c = new HttpClient({ timeoutMs: 1_000, baseUrl: 'http://test.local' });
    c.on('metrics', (m: HttpMetrics) => events.push(m));
    await expect(c.get('/m4')).rejects.toBeDefined();
    expect(events.length).toBe(1);
    expect(events[0]!.errorClass).toBe('http');
    expect(events[0]!.statusCode).toBe(404);
  });

  it('emits metrics with errorClass=circuit_open when breaker rejects', async () => {
    server.use(
      http.get('http://test.local/m5', () => new HttpResponse('x', { status: 500 })),
    );
    const events: HttpMetrics[] = [];
    const clock = mkClock(0);
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      circuitBreaker: { failureThreshold: 1, recoveryMs: 10_000 },
      now: clock.now,
      delay: d.delay,
      random: () => 0,
    });
    c.on('metrics', (m: HttpMetrics) => events.push(m));
    await expect(c.get('/m5')).rejects.toBeDefined();
    await expect(c.get('/m5')).rejects.toMatchObject({
      message: expect.stringContaining('circuit'),
    });
    expect(events.length).toBe(2);
    expect(events[1]!.errorClass).toBe('circuit_open');
  });

  it('metrics retryCount reflects attempts - 1 on success after retry', async () => {
    let hits = 0;
    server.use(
      http.get('http://test.local/m6', () => {
        hits += 1;
        if (hits < 3) return new HttpResponse('x', { status: 503 });
        return new HttpResponse('ok', { status: 200 });
      }),
    );
    const events: HttpMetrics[] = [];
    const d = mkDelayRecorder();
    const c = new HttpClient({
      timeoutMs: 1_000,
      baseUrl: 'http://test.local',
      retry: { attempts: 3, backoffMs: 1, jitter: 0 },
      delay: d.delay,
      random: () => 0,
    });
    c.on('metrics', (m: HttpMetrics) => events.push(m));
    await c.get('/m6');
    expect(events.length).toBe(1);
    expect(events[0]!.retryCount).toBe(2);
    expect(events[0]!.statusCode).toBe(200);
  });
});
