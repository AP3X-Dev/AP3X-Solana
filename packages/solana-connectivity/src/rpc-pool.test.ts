import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import { RpcError } from '@ap3x/solana-core';

import { RpcPool, type RpcEndpoint, type RpcMetricEvent } from './rpc-pool';

// ---------------------------------------------------------------------------
// msw bootstrap
// ---------------------------------------------------------------------------

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HELIUS: RpcEndpoint = { name: 'helius', url: 'http://helius.test', kind: 'http' };
const TRITON: RpcEndpoint = { name: 'triton', url: 'http://triton.test', kind: 'http' };
const QUICK: RpcEndpoint = { name: 'quicknode', url: 'http://quicknode.test', kind: 'http' };

function mkClock(start = 0) {
  const state = { now: start };
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms;
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

/** msw handler returning `{ result: <value> }` on POST. */
function ok(url: string, result: unknown, latencyMs = 0, clock?: { advance: (ms: number) => void }) {
  return http.post(url, async () => {
    if (latencyMs > 0 && clock) clock.advance(latencyMs);
    return HttpResponse.json({ jsonrpc: '2.0', id: 1, result });
  });
}

/** msw handler returning a JSON-RPC method error envelope. */
function methodError(url: string, code: number, message: string) {
  return http.post(url, async () =>
    HttpResponse.json({ jsonrpc: '2.0', id: 1, error: { code, message } }),
  );
}

/** msw handler returning a 500 for transport-level retry testing. */
function http500(url: string) {
  return http.post(url, () => new HttpResponse('fail', { status: 500 }));
}

/** msw handler that errors out of fetch entirely (network failure). */
function networkError(url: string) {
  return http.post(url, () => HttpResponse.error());
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('RpcPool — construction', () => {
  it('throws on empty endpoint list', () => {
    expect(() => new RpcPool({ endpoints: [] })).toThrow(/at least one endpoint/);
  });

  it('rejects unknown strategy', () => {
    expect(
      () =>
        new RpcPool({
          endpoints: [HELIUS],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          strategy: 'weighted' as any,
        }),
    ).toThrow(/unknown strategy/);
  });

  it('exposes configured endpoints via endpoints()', () => {
    const p = new RpcPool({ endpoints: [HELIUS, TRITON] });
    expect(p.endpoints().map((e) => e.name)).toEqual(['helius', 'triton']);
  });
});

// ---------------------------------------------------------------------------
// Round-robin
// ---------------------------------------------------------------------------

describe('RpcPool — round-robin reads', () => {
  it('distributes calls across healthy endpoints in A-B-A order', async () => {
    const heliusHits: string[] = [];
    const tritonHits: string[] = [];
    server.use(
      http.post('http://helius.test', async () => {
        heliusHits.push('hit');
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'H' });
      }),
      http.post('http://triton.test', async () => {
        tritonHits.push('hit');
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'T' });
      }),
    );
    const clock = mkClock();
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      now: clock.now,
      delay,
    });

    const r1 = await pool.call('getSlot', []);
    const r2 = await pool.call('getSlot', []);
    const r3 = await pool.call('getSlot', []);

    expect([r1, r2, r3]).toEqual(['H', 'T', 'H']);
    expect(heliusHits.length).toBe(2);
    expect(tritonHits.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

describe('RpcPool — failover', () => {
  it('failed transport retries against the next endpoint', async () => {
    let heliusHits = 0;
    let tritonHits = 0;
    server.use(
      http.post('http://helius.test', () => {
        heliusHits += 1;
        return new HttpResponse('fail', { status: 500 });
      }),
      http.post('http://triton.test', async () => {
        tritonHits += 1;
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'T' });
      }),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      retry: { attempts: 3, backoffMs: 5, jitter: 0 },
      delay,
    });

    const r = await pool.call('getSlot', []);
    expect(r).toBe('T');
    expect(heliusHits).toBe(1);
    expect(tritonHits).toBe(1);
  });

  it('demotes an endpoint to degraded after 5 errors, stops round-robining to it', async () => {
    // Three endpoints: H (fails forever), T (ok), Q (ok). After H hits
    // degraded, subsequent calls should only touch T and Q.
    let heliusHits = 0;
    const tritonHits: number[] = [];
    const quickHits: number[] = [];
    server.use(
      http.post('http://helius.test', () => {
        heliusHits += 1;
        return new HttpResponse('fail', { status: 500 });
      }),
      http.post('http://triton.test', async () => {
        tritonHits.push(1);
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'T' });
      }),
      http.post('http://quicknode.test', async () => {
        quickHits.push(1);
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'Q' });
      }),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON, QUICK],
      timeoutMs: 1_000,
      retry: { attempts: 3, backoffMs: 5, jitter: 0 },
      delay,
    });

    // Hit the pool enough times that helius accumulates 5 consecutive errors.
    // With 3 endpoints and round-robin advancing the cursor every pick,
    // helius gets picked roughly every third call; 15 calls guarantees at
    // least 5 helius attempts even with failovers.
    for (let i = 0; i < 15; i++) {
      await pool.call('getSlot', []);
    }
    // After 15 calls, helius has accumulated >= 5 errors and should have
    // transitioned to `degraded`. Subsequent calls should skip it entirely
    // as long as a healthy peer exists.
    expect(heliusHits).toBeGreaterThanOrEqual(5);

    const before = heliusHits;
    // 4 more calls — with helius degraded and two healthy peers, none should
    // land on helius.
    for (let i = 0; i < 4; i++) {
      await pool.call('getSlot', []);
    }
    expect(heliusHits).toBe(before);
  });

  it('throws RpcError when all endpoints become unhealthy', async () => {
    server.use(
      http.post('http://helius.test', () => new HttpResponse('x', { status: 500 })),
      http.post('http://triton.test', () => new HttpResponse('x', { status: 500 })),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      retry: { attempts: 2, backoffMs: 1, jitter: 0 },
      delay,
    });

    // Burn both endpoints into unhealthy. 10 errors per endpoint = 20 total
    // failed requests, so 10 pool calls at 2 attempts each gets us there.
    for (let i = 0; i < 10; i++) {
      await expect(pool.call('getSlot', [])).rejects.toBeInstanceOf(RpcError);
    }
    // Now both should be unhealthy.
    await expect(pool.call('getSlot', [])).rejects.toBeInstanceOf(RpcError);
  });
});

// ---------------------------------------------------------------------------
// JSON-RPC method errors (no retry)
// ---------------------------------------------------------------------------

describe('RpcPool — JSON-RPC method errors', () => {
  it('throws RpcError with rpc.rpc_method code and does not retry', async () => {
    let hits = 0;
    server.use(
      http.post('http://helius.test', async () => {
        hits += 1;
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32602, message: 'Invalid params' },
        });
      }),
      // Triton should never be touched — the rpc_method error must not failover.
      http.post('http://triton.test', async () => {
        throw new Error('should not be called');
      }),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      retry: { attempts: 5, backoffMs: 5, jitter: 0 },
      delay,
    });

    const err = await pool.call('getBalance', [{}]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    const rpcErr = err as RpcError;
    expect(rpcErr.code).toBe('rpc.rpc_method');
    expect(rpcErr.meta.rpcCode).toBe(-32602);
    expect(hits).toBe(1);
  });

  it('rpc_method errors record a success on the endpoint (transport OK)', async () => {
    server.use(methodError('http://helius.test', -32000, 'x'));
    const pool = new RpcPool({
      endpoints: [HELIUS],
      timeoutMs: 1_000,
      retry: { attempts: 1, backoffMs: 0, jitter: 0 },
    });
    for (let i = 0; i < 20; i++) {
      await pool.call('foo', []).catch(() => undefined);
    }
    // The endpoint should still be healthy — 20 method errors don't promote
    // it toward degraded since each envelope was well-formed.
    expect(pool.endpoints()[0]!.name).toBe('helius');
    // Transactional probe: one more call, this time with a success handler,
    // should go through on the same endpoint.
    server.resetHandlers();
    server.use(ok('http://helius.test', 'OK'));
    const r = await pool.call('foo', []);
    expect(r).toBe('OK');
  });
});

// ---------------------------------------------------------------------------
// pinForWrite
// ---------------------------------------------------------------------------

describe('RpcPool — pinForWrite', () => {
  it('returns the lowest-EWMA healthy endpoint once both are seeded', async () => {
    const clock = mkClock();
    // helius slow, triton fast. After a call each, triton should have lower EWMA.
    server.use(
      http.post('http://helius.test', async () => {
        clock.advance(200);
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'H' });
      }),
      http.post('http://triton.test', async () => {
        clock.advance(20);
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'T' });
      }),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      now: clock.now,
      delay,
    });
    // Seed both endpoints with one call each.
    await pool.call('getSlot', []);
    await pool.call('getSlot', []);

    expect(pool.pinForWrite().name).toBe('triton');
  });

  it('prefers a healthy endpoint over a degraded one even if the degraded is faster', async () => {
    // Force helius to degrade (5 errors), triton healthy but slower.
    // pinForWrite should still pick triton because it's healthy.
    const clock = mkClock();
    let heliusCalls = 0;
    server.use(
      http.post('http://helius.test', () => {
        heliusCalls += 1;
        // Every call fails, moving helius toward degraded quickly.
        return new HttpResponse('x', { status: 500 });
      }),
      http.post('http://triton.test', async () => {
        clock.advance(500); // slow but works
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'T' });
      }),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      retry: { attempts: 2, backoffMs: 1, jitter: 0 },
      now: clock.now,
      delay,
    });
    // Drive enough calls to degrade helius.
    for (let i = 0; i < 8; i++) {
      await pool.call('getSlot', []);
    }
    expect(heliusCalls).toBeGreaterThanOrEqual(5);
    expect(pool.pinForWrite().name).toBe('triton');
  });

  it('throws when every endpoint is unhealthy', async () => {
    server.use(
      http.post('http://helius.test', () => new HttpResponse('x', { status: 500 })),
      http.post('http://triton.test', () => new HttpResponse('x', { status: 500 })),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      retry: { attempts: 2, backoffMs: 1, jitter: 0 },
      delay,
    });
    for (let i = 0; i < 10; i++) {
      await pool.call('getSlot', []).catch(() => undefined);
    }
    expect(() => pool.pinForWrite()).toThrow(/no healthy endpoints/);
  });

  it('falls back to a degraded endpoint when no healthy peer exists', async () => {
    // Only one endpoint, driven into degraded. pinForWrite should still
    // return it — a degraded endpoint beats throwing when nothing better
    // exists.
    let hits = 0;
    server.use(
      http.post('http://helius.test', () => {
        hits += 1;
        return new HttpResponse('x', { status: 500 });
      }),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS],
      timeoutMs: 1_000,
      retry: { attempts: 1, backoffMs: 0, jitter: 0 },
      delay,
    });
    for (let i = 0; i < 5; i++) {
      await pool.call('getSlot', []).catch(() => undefined);
    }
    // Now degraded (5 errors, not yet 10).
    expect(hits).toBe(5);
    expect(pool.pinForWrite().name).toBe('helius');
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('RpcPool — metrics events', () => {
  it('emits one metric event per call with the documented shape on success', async () => {
    const clock = mkClock();
    server.use(
      http.post('http://helius.test', async () => {
        clock.advance(42);
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'OK' });
      }),
    );
    const pool = new RpcPool({ endpoints: [HELIUS], timeoutMs: 1_000, now: clock.now });
    const events: RpcMetricEvent[] = [];
    pool.on('metrics', (ev) => events.push(ev));

    await pool.call('getSlot', []);

    expect(events.length).toBe(1);
    const [ev] = events;
    expect(ev!.endpoint).toBe('helius');
    expect(ev!.healthState).toBe('healthy');
    expect(ev!.latencyMs).toBe(42);
    expect(ev!.retryCount).toBe(0);
    expect(ev!.errorClass).toBeUndefined();
  });

  it('emits errorClass on transport failure', async () => {
    server.use(http500('http://helius.test'));
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS],
      timeoutMs: 1_000,
      retry: { attempts: 1, backoffMs: 0, jitter: 0 },
      delay,
    });
    const events: RpcMetricEvent[] = [];
    pool.on('metrics', (ev) => events.push(ev));

    await expect(pool.call('getSlot', [])).rejects.toBeInstanceOf(RpcError);

    expect(events.length).toBe(1);
    expect(events[0]!.errorClass).toBe('http');
  });

  it('emits errorClass=rpc_method on JSON-RPC method errors', async () => {
    server.use(methodError('http://helius.test', -32000, 'boom'));
    const pool = new RpcPool({ endpoints: [HELIUS], timeoutMs: 1_000 });
    const events: RpcMetricEvent[] = [];
    pool.on('metrics', (ev) => events.push(ev));

    await expect(pool.call('getSlot', [])).rejects.toBeInstanceOf(RpcError);

    expect(events.length).toBe(1);
    expect(events[0]!.errorClass).toBe('rpc_method');
  });

  it('retryCount reflects the number of retries used', async () => {
    let heliusHits = 0;
    server.use(
      http.post('http://helius.test', () => {
        heliusHits += 1;
        return new HttpResponse('fail', { status: 500 });
      }),
      http.post('http://triton.test', async () => {
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'T' });
      }),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      retry: { attempts: 3, backoffMs: 1, jitter: 0 },
      delay,
    });
    const events: RpcMetricEvent[] = [];
    pool.on('metrics', (ev) => events.push(ev));

    const r = await pool.call('getSlot', []);
    expect(r).toBe('T');
    // Helius failed (attempt 1), triton succeeded (attempt 2). retryCount = 1.
    expect(events.length).toBe(1);
    expect(events[0]!.retryCount).toBe(1);
    expect(events[0]!.endpoint).toBe('triton');
    expect(heliusHits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Malformed response bodies
// ---------------------------------------------------------------------------

describe('RpcPool — response parsing', () => {
  it('throws rpc.parse when the response is not JSON', async () => {
    server.use(
      http.post('http://helius.test', () =>
        new HttpResponse('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS],
      timeoutMs: 1_000,
      retry: { attempts: 1, backoffMs: 0, jitter: 0 },
      delay,
    });
    const err = await pool.call('getSlot', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe('rpc.parse');
  });
});

// ---------------------------------------------------------------------------
// Network errors classification
// ---------------------------------------------------------------------------

describe('RpcPool — network error handling', () => {
  it('classifies fetch-level failure as network and failovers', async () => {
    let tritonHits = 0;
    server.use(
      networkError('http://helius.test'),
      http.post('http://triton.test', async () => {
        tritonHits += 1;
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 'T' });
      }),
    );
    const { delay } = mkDelayRecorder();
    const pool = new RpcPool({
      endpoints: [HELIUS, TRITON],
      timeoutMs: 1_000,
      retry: { attempts: 3, backoffMs: 1, jitter: 0 },
      delay,
    });
    const events: RpcMetricEvent[] = [];
    pool.on('metrics', (ev) => events.push(ev));

    const r = await pool.call('getSlot', []);
    expect(r).toBe('T');
    expect(tritonHits).toBe(1);
    expect(events[0]!.retryCount).toBe(1);
  });
});
