import { describe, it, expect } from 'vitest';
import { HeliusAdmin } from './admin.js';

interface FakeApiState {
  /** webhookId -> stored config */
  webhooks: Record<string, { accountAddresses?: string[]; webhookID?: string; [key: string]: unknown }>;
  /** Captured PUT bodies for assertions. */
  puts: Array<{ webhookId: string; body: Record<string, unknown> }>;
}

function makeFakeFetch(state: FakeApiState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const segments = url.pathname.split('/').filter(Boolean);
    // /v0/webhooks/{webhookId}
    const webhookId = decodeURIComponent(segments[2] ?? '');
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      const cfg = state.webhooks[webhookId];
      if (!cfg) {
        return { ok: false, status: 404, statusText: 'Not Found', async json() { return {}; } } as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', async json() { return cfg; } } as Response;
    }

    if (method === 'PUT') {
      const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
      state.puts.push({ webhookId, body });
      state.webhooks[webhookId] = { ...state.webhooks[webhookId], ...body };
      return { ok: true, status: 200, statusText: 'OK', async json() { return body; } } as Response;
    }

    return { ok: false, status: 405, statusText: 'Method Not Allowed', async json() { return {}; } } as Response;
  }) as typeof fetch;
}

describe('HeliusAdmin', () => {
  // ── subscribeAddresses ────────────────────────────────────────────

  it('subscribeAddresses adds new addresses to the existing set', async () => {
    const state: FakeApiState = {
      webhooks: { 'wh-1': { accountAddresses: ['A', 'B'], transactionTypes: ['SWAP'] } },
      puts: [],
    };
    const a = new HeliusAdmin({ apiKey: 'k', fetch: makeFakeFetch(state) });

    await a.subscribeAddresses('wh-1', ['C', 'D']);

    expect(state.puts).toHaveLength(1);
    expect(state.puts[0]?.webhookId).toBe('wh-1');
    const next = state.puts[0]?.body['accountAddresses'] as string[];
    expect(new Set(next)).toEqual(new Set(['A', 'B', 'C', 'D']));
    // Pass-through field preserved.
    expect(state.puts[0]?.body['transactionTypes']).toEqual(['SWAP']);
  });

  it('subscribeAddresses is idempotent — adding existing addresses is a no-op set-wise', async () => {
    const state: FakeApiState = {
      webhooks: { 'wh-1': { accountAddresses: ['A', 'B'] } },
      puts: [],
    };
    const a = new HeliusAdmin({ apiKey: 'k', fetch: makeFakeFetch(state) });

    await a.subscribeAddresses('wh-1', ['A']);
    expect(state.webhooks['wh-1']?.accountAddresses?.sort()).toEqual(['A', 'B']);
  });

  // ── removeAddresses ───────────────────────────────────────────────

  it('removeAddresses subtracts from the existing set', async () => {
    const state: FakeApiState = {
      webhooks: { 'wh-1': { accountAddresses: ['A', 'B', 'C'] } },
      puts: [],
    };
    const a = new HeliusAdmin({ apiKey: 'k', fetch: makeFakeFetch(state) });

    await a.removeAddresses('wh-1', ['B']);
    expect(state.webhooks['wh-1']?.accountAddresses).toEqual(['A', 'C']);
  });

  it('removeAddresses on absent addresses is a no-op set-wise', async () => {
    const state: FakeApiState = {
      webhooks: { 'wh-1': { accountAddresses: ['A'] } },
      puts: [],
    };
    const a = new HeliusAdmin({ apiKey: 'k', fetch: makeFakeFetch(state) });

    await a.removeAddresses('wh-1', ['Z']);
    expect(state.webhooks['wh-1']?.accountAddresses).toEqual(['A']);
  });

  // ── reconcile ─────────────────────────────────────────────────────

  it('reconcile reports added/removed and converges to desired', async () => {
    const state: FakeApiState = {
      webhooks: { 'wh-1': { accountAddresses: ['A', 'B', 'C'] } },
      puts: [],
    };
    const a = new HeliusAdmin({ apiKey: 'k', fetch: makeFakeFetch(state) });

    const result = await a.reconcile('wh-1', ['B', 'C', 'D', 'E']);

    expect(result.added.sort()).toEqual(['D', 'E']);
    expect(result.removed.sort()).toEqual(['A']);
    expect(new Set(state.webhooks['wh-1']?.accountAddresses)).toEqual(new Set(['B', 'C', 'D', 'E']));
  });

  it('reconcile is a no-op when desired matches current', async () => {
    const state: FakeApiState = {
      webhooks: { 'wh-1': { accountAddresses: ['A', 'B'] } },
      puts: [],
    };
    const a = new HeliusAdmin({ apiKey: 'k', fetch: makeFakeFetch(state) });

    const result = await a.reconcile('wh-1', ['B', 'A']);
    expect(result).toEqual({ added: [], removed: [] });
    // No PUT issued.
    expect(state.puts).toHaveLength(0);
  });

  // ── error handling ────────────────────────────────────────────────

  it('throws on a failed GET', async () => {
    const state: FakeApiState = { webhooks: {}, puts: [] };
    const a = new HeliusAdmin({ apiKey: 'k', fetch: makeFakeFetch(state) });
    await expect(a.subscribeAddresses('missing', ['A'])).rejects.toThrow(/404/);
  });

  it('throws on a failed PUT', async () => {
    const fetchImpl: typeof fetch = (async (_input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        return { ok: true, status: 200, statusText: 'OK', async json() { return { accountAddresses: [] }; } } as Response;
      }
      return { ok: false, status: 500, statusText: 'Server Error', async json() { return {}; } } as Response;
    }) as typeof fetch;

    const a = new HeliusAdmin({ apiKey: 'k', fetch: fetchImpl });
    await expect(a.subscribeAddresses('wh-1', ['A'])).rejects.toThrow(/500/);
  });

  it('does not echo the readback-only webhookID field on PUT', async () => {
    const state: FakeApiState = {
      webhooks: { 'wh-1': { webhookID: 'wh-1', accountAddresses: ['A'] } },
      puts: [],
    };
    const a = new HeliusAdmin({ apiKey: 'k', fetch: makeFakeFetch(state) });

    await a.subscribeAddresses('wh-1', ['B']);
    expect(state.puts[0]?.body).not.toHaveProperty('webhookID');
  });
});
