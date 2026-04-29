import { describe, it, expect } from 'vitest';
import { Healthz } from './healthz.js';

describe('Healthz', () => {
  it('starts unhealthy when no events have been recorded', () => {
    const h = new Healthz();
    expect(h.isHealthy()).toBe(false);
    expect(h.lastEventAt()).toBeNull();
  });

  it('reports healthy after recordEvent within the threshold', () => {
    let now = 1_000_000;
    const h = new Healthz({ silentThresholdMs: 1_000, now: () => now });
    h.recordEvent(now);
    expect(h.isHealthy()).toBe(true);

    now += 500; // still within
    expect(h.isHealthy()).toBe(true);

    now += 600; // 1100ms after recordEvent — beyond threshold
    expect(h.isHealthy()).toBe(false);
  });

  it('lastEventAt() returns the most recent recordEvent', () => {
    const h = new Healthz();
    h.recordEvent(1_000_000);
    expect(h.lastEventAt()?.getTime()).toBe(1_000_000);
    h.recordEvent(2_000_000);
    expect(h.lastEventAt()?.getTime()).toBe(2_000_000);
  });

  it('startedAt initialises the probe', () => {
    const now = 1_000_000;
    const h = new Healthz({ startedAt: now, silentThresholdMs: 5_000, now: () => now });
    expect(h.isHealthy()).toBe(true);
  });

  it('handler returns 200 + JSON when healthy', async () => {
    const h = new Healthz({ startedAt: Date.now() });
    const handler = h.handler();
    const res = mockResponse();
    handler({} as never, res.handle as never);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { healthy: boolean };
    expect(body.healthy).toBe(true);
  });

  it('handler returns 503 + JSON when unhealthy', async () => {
    const h = new Healthz();
    const handler = h.handler();
    const res = mockResponse();
    handler({} as never, res.handle as never);
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body) as { healthy: boolean; lastEventAt: null };
    expect(body.healthy).toBe(false);
    expect(body.lastEventAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tiny mock for ServerResponse.
// ---------------------------------------------------------------------------

interface MockRes {
  status: number;
  body: string;
  handle: {
    writeHead(status: number, headers: Record<string, string>): void;
    end(body: string): void;
  };
}

function mockResponse(): MockRes {
  const res: MockRes = {
    status: 0,
    body: '',
    handle: {
      writeHead(status) { res.status = status; },
      end(body) { res.body = body; },
    },
  };
  return res;
}
