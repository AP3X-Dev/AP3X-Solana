/**
 * Diagnostic probe tests.
 *
 * Three layers:
 *
 *   1) `probeRpc` against an msw-mocked HTTP endpoint — we construct a real
 *      `RpcPool` internally, so the probe exercises the full call path.
 *
 *   2) `probeGeyser` with an injected fake `GrpcAdapter`. We reuse the
 *      FakeStream pattern from geyser-client.test.ts so the probe runs
 *      deterministically against emitted updates without any real network.
 *
 *   3) `compareProviders` — asserts slot/latency deltas when both probes
 *      complete, and `undefined` when a side is missing.
 *
 * The CLI dispatch (`main()` in cli.ts) is tested via a separate describe
 * block below using captured argv + stdout/stderr.
 */

import { EventEmitter } from 'node:events';

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import type {
  GrpcAdapter,
  GrpcClientHandle,
  GrpcDuplexStream,
  GeyserUpdate,
} from '../geyser-client';
import type { RpcEndpoint } from '../rpc-pool';

import {
  probeRpc,
  probeGeyser,
  compareProviders,
  type RpcProbeResult,
  type GeyserProbeResult,
} from './probes';

// ---------------------------------------------------------------------------
// msw bootstrap
// ---------------------------------------------------------------------------

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const HELIUS: RpcEndpoint = { name: 'helius', url: 'http://helius.test', kind: 'http' };
const TRITON: RpcEndpoint = { name: 'triton', url: 'http://triton.test', kind: 'http' };

// ---------------------------------------------------------------------------
// Fake gRPC adapter (shared-flavour with geyser-client.test.ts)
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter {
  writes: unknown[] = [];
  cancelled = false;
  ended = false;

  write(message: unknown): boolean {
    this.writes.push(message);
    return true;
  }
  end(): void {
    this.ended = true;
    this.emit('end');
  }
  cancel(): void {
    this.cancelled = true;
    this.emit('close');
  }
  pushData(update: GeyserUpdate): void {
    this.emit('data', update);
  }
  pushError(err: Error): void {
    this.emit('error', err);
  }
  asDuplex(): GrpcDuplexStream {
    return this as unknown as GrpcDuplexStream;
  }
}

class FakeClient implements GrpcClientHandle {
  stream = new FakeStream();
  closed = false;
  subscribe(): GrpcDuplexStream {
    return this.stream.asDuplex();
  }
  close(): void {
    this.closed = true;
  }
}

function mkFakeAdapter(): { adapter: GrpcAdapter; client: FakeClient } {
  const client = new FakeClient();
  const adapter: GrpcAdapter = {
    createClient() {
      return client;
    },
  };
  return { adapter, client };
}

// ---------------------------------------------------------------------------
// probeRpc
// ---------------------------------------------------------------------------

describe('probeRpc', () => {
  it('returns ok + latencyMs + slot on a healthy endpoint', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 123456 }),
      ),
    );
    const result = await probeRpc(HELIUS);
    expect(result.ok).toBe(true);
    expect(result.endpoint).toBe('helius');
    expect(result.slot).toBe(123456);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.errorClass).toBeUndefined();
  });

  it('returns ok=false + errorClass on HTTP 500', async () => {
    server.use(
      http.post(HELIUS.url, () => new HttpResponse('boom', { status: 500 })),
    );
    const result = await probeRpc(HELIUS, { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBeDefined();
    expect(result.error).toBeDefined();
    expect(result.slot).toBeUndefined();
  });

  it('returns ok=false with latency measured on transport error', async () => {
    server.use(http.post(HELIUS.url, () => HttpResponse.error()));
    const result = await probeRpc(HELIUS, { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('honours the supplied timeout', async () => {
    // Handler never responds — probe should time out and report a failure.
    server.use(
      http.post(HELIUS.url, async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 0 });
      }),
    );
    const result = await probeRpc(HELIUS, { timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// probeGeyser
// ---------------------------------------------------------------------------

describe('probeGeyser', () => {
  it('returns ok + slotsObserved + latencyP50 after duration', async () => {
    const { adapter, client } = mkFakeAdapter();
    // Emit updates immediately after subscribe; the probe will close after
    // 50 ms. Push on the next microtask so subscribe() has registered
    // handlers.
    queueMicrotask(() => {
      client.stream.pushData({ slot: { slot: 100 } });
      client.stream.pushData({ slot: { slot: 101 } });
      client.stream.pushData({ slot: { slot: 102 } });
    });
    const result = await probeGeyser(
      { url: 'fake://localhost', insecure: true },
      { durationMs: 50, grpc: adapter },
    );
    expect(result.ok).toBe(true);
    expect(result.slotsObserved).toBe(3);
    expect(result.latencyP50).toBeGreaterThanOrEqual(0);
    expect(result.errorClass).toBeUndefined();
  });

  it('returns ok=false with zero slots if none observed', async () => {
    const { adapter } = mkFakeAdapter();
    const result = await probeGeyser(
      { url: 'fake://localhost', insecure: true },
      { durationMs: 30, grpc: adapter },
    );
    expect(result.ok).toBe(false);
    expect(result.slotsObserved).toBe(0);
  });

  it('surfaces stream errors as errorClass=network', async () => {
    const { adapter, client } = mkFakeAdapter();
    queueMicrotask(() => {
      client.stream.pushError(new Error('rst_stream'));
    });
    const result = await probeGeyser(
      { url: 'fake://localhost', insecure: true },
      { durationMs: 200, grpc: adapter },
    );
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe('network');
    expect(result.error).toContain('rst_stream');
  });
});

// ---------------------------------------------------------------------------
// compareProviders
// ---------------------------------------------------------------------------

describe('compareProviders', () => {
  it('computes slotDelta + latencyDelta when both RPC probes succeed', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 100 }),
      ),
      http.post(TRITON.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 105 }),
      ),
    );
    const cmp = await compareProviders(
      { name: 'helius', rpc: HELIUS },
      { name: 'triton', rpc: TRITON },
    );
    expect(cmp.aRpc?.ok).toBe(true);
    expect(cmp.bRpc?.ok).toBe(true);
    expect(cmp.slotDelta).toBe(5);
    // Either sign is fine — just check it was computed.
    expect(cmp.latencyDelta).toBeDefined();
  });

  it('leaves slotDelta undefined when one RPC fails', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 100 }),
      ),
      http.post(TRITON.url, () => new HttpResponse('fail', { status: 500 })),
    );
    const cmp = await compareProviders(
      { name: 'helius', rpc: HELIUS },
      { name: 'triton', rpc: TRITON },
    );
    expect(cmp.aRpc?.ok).toBe(true);
    expect(cmp.bRpc?.ok).toBe(false);
    expect(cmp.slotDelta).toBeUndefined();
  });

  it('omits geyser probes when not provided', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 100 }),
      ),
      http.post(TRITON.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 100 }),
      ),
    );
    const cmp = await compareProviders(
      { name: 'helius', rpc: HELIUS },
      { name: 'triton', rpc: TRITON },
    );
    expect(cmp.aGeyser).toBeUndefined();
    expect(cmp.bGeyser).toBeUndefined();
  });

  it('runs RPC and Geyser probes in parallel when both supplied', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 50 }),
      ),
      http.post(TRITON.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 52 }),
      ),
    );
    const { adapter: aGrpc, client: aClient } = mkFakeAdapter();
    const { adapter: bGrpc, client: bClient } = mkFakeAdapter();
    queueMicrotask(() => {
      aClient.stream.pushData({ slot: { slot: 1 } });
      bClient.stream.pushData({ slot: { slot: 2 } });
      bClient.stream.pushData({ slot: { slot: 3 } });
    });
    const cmp = await compareProviders(
      {
        name: 'helius',
        rpc: HELIUS,
        geyser: { url: 'fake://a', insecure: true, grpc: aGrpc },
      },
      {
        name: 'triton',
        rpc: TRITON,
        geyser: { url: 'fake://b', insecure: true, grpc: bGrpc },
      },
      { geyserDurationMs: 50 },
    );
    expect(cmp.aRpc?.ok).toBe(true);
    expect(cmp.bRpc?.ok).toBe(true);
    expect(cmp.aGeyser?.slotsObserved).toBe(1);
    expect(cmp.bGeyser?.slotsObserved).toBe(2);
    expect(cmp.slotDelta).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CLI dispatch — main()
// ---------------------------------------------------------------------------

describe('cli main() dispatch', () => {
  it('probe-rpc outputs JSON + exits 0 on success', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 999 }),
      ),
    );
    const { main } = await import('./cli');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ['probe-rpc', '--url', HELIUS.url, '--name', 'helius'],
      { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.ok).toBe(true);
    expect(parsed.slot).toBe(999);
    expect(stderr.join('')).toBe('');
  });

  it('probe-rpc --check exits 1 on failure', async () => {
    server.use(
      http.post(HELIUS.url, () => new HttpResponse('fail', { status: 500 })),
    );
    const { main } = await import('./cli');
    const stdout: string[] = [];
    const code = await main(
      ['probe-rpc', '--url', HELIUS.url, '--name', 'helius', '--check', '--timeout', '200'],
      { stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.ok).toBe(false);
  });

  it('probe-rpc without --check still exits 0 on failure', async () => {
    server.use(
      http.post(HELIUS.url, () => new HttpResponse('fail', { status: 500 })),
    );
    const { main } = await import('./cli');
    const stdout: string[] = [];
    const code = await main(
      ['probe-rpc', '--url', HELIUS.url, '--name', 'helius', '--timeout', '200'],
      { stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.ok).toBe(false);
  });

  it('unknown command exits 2 with a usage message on stderr', async () => {
    const { main } = await import('./cli');
    const stderr: string[] = [];
    const code = await main(['nope'], {
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    });
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/Usage/i);
  });

  it('missing --url for probe-rpc exits 2', async () => {
    const { main } = await import('./cli');
    const stderr: string[] = [];
    const code = await main(['probe-rpc'], {
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    });
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/--url/);
  });

  it('compare-providers returns combined JSON', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 100 }),
      ),
      http.post(TRITON.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 102 }),
      ),
    );
    const { main } = await import('./cli');
    const stdout: string[] = [];
    const code = await main(
      [
        'compare-providers',
        '--a-name', 'helius',
        '--a-url', HELIUS.url,
        '--b-name', 'triton',
        '--b-url', TRITON.url,
      ],
      { stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.slotDelta).toBe(2);
    expect(parsed.aRpc.slot).toBe(100);
    expect(parsed.bRpc.slot).toBe(102);
  });

  it('probe-geyser requires --url', async () => {
    const { main } = await import('./cli');
    const stderr: string[] = [];
    const code = await main(['probe-geyser'], {
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    });
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/--url/);
  });

  it('probe-geyser outputs JSON and respects --check on no slots', async () => {
    const { main } = await import('./cli');
    const stdout: string[] = [];
    // We can't inject a fake gRPC adapter through CLI args, so we hit a
    // URL that will immediately fail: no server listening at 127.0.0.1:1.
    // Default adapter will throw synchronously on createClient, which
    // `start()` turns into an 'error' event the probe records. Zero slots
    // observed → ok=false → exit 1 with --check.
    const code = await main(
      [
        'probe-geyser',
        '--url',
        '127.0.0.1:1',
        '--insecure',
        '--duration',
        '30',
        '--check',
      ],
      { stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.ok).toBe(false);
    expect(parsed.slotsObserved).toBe(0);
    expect(code).toBe(1);
  });

  it('probe-rpc coerces unknown endpoint names to "custom"', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 42 }),
      ),
    );
    const { main } = await import('./cli');
    const stdout: string[] = [];
    const code = await main(
      ['probe-rpc', '--url', HELIUS.url, '--name', 'weird-provider'],
      { stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    // 'weird-provider' is not in the allowed union; falls back to 'custom'.
    expect(parsed.endpoint).toBe('custom');
  });

  it('probe-rpc accepts a canonical provider name', async () => {
    server.use(
      http.post(TRITON.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 1 }),
      ),
    );
    const { main } = await import('./cli');
    const stdout: string[] = [];
    const code = await main(
      ['probe-rpc', '--url', TRITON.url, '--name', 'triton'],
      { stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.endpoint).toBe('triton');
  });

  it('compare-providers missing an argument exits 2', async () => {
    const { main } = await import('./cli');
    const stderr: string[] = [];
    const code = await main(
      ['compare-providers', '--a-name', 'helius', '--a-url', HELIUS.url],
      { stdout: () => {}, stderr: (s) => stderr.push(s) },
    );
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/compare-providers/);
  });

  it('ignores a non-numeric --timeout value', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 7 }),
      ),
    );
    const { main } = await import('./cli');
    const stdout: string[] = [];
    const code = await main(
      ['probe-rpc', '--url', HELIUS.url, '--timeout', 'not-a-number'],
      { stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    expect(code).toBe(0);
  });

  it('compare-providers --check exits 1 if any probe fails', async () => {
    server.use(
      http.post(HELIUS.url, async () =>
        HttpResponse.json({ jsonrpc: '2.0', id: 1, result: 100 }),
      ),
      http.post(TRITON.url, () => new HttpResponse('fail', { status: 500 })),
    );
    const { main } = await import('./cli');
    const stdout: string[] = [];
    const code = await main(
      [
        'compare-providers',
        '--a-name', 'helius',
        '--a-url', HELIUS.url,
        '--b-name', 'triton',
        '--b-url', TRITON.url,
        '--check',
        '--timeout', '200',
      ],
      { stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    expect(code).toBe(1);
  });
});

// Consumers of this module may want to assert the types are assignable.
// This keeps tsc honest that the result types stay exported.
const _typeAssertionRpc: RpcProbeResult = {
  ok: true,
  endpoint: 'helius',
  latencyMs: 0,
};
const _typeAssertionGeyser: GeyserProbeResult = {
  ok: true,
  endpoint: 'fake',
  slotsObserved: 0,
};
// Silence unused warnings for type assertions.
vi.stubGlobal('__diag_type_assertions', [_typeAssertionRpc, _typeAssertionGeyser]);
