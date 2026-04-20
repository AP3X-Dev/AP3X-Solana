import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HttpClient, PublicKey } from '@ap3x/solana-core';
import { JitoHttpSubmitter } from './jito-http.js';

const server = setupServer(
  http.post('https://mainnet.block-engine.jito.wtf/api/v1/bundles', async () =>
    HttpResponse.json({ result: 'bundle-uuid-abc' }),
  ),
);

beforeAll(() => server.listen());
afterAll(() => server.close());

const tipAccount = PublicKey.fromBase58('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

describe('JitoHttpSubmitter', () => {
  it('POSTs a bundle and returns the bundle UUID', async () => {
    const sub = new JitoHttpSubmitter({
      httpClient: new HttpClient({ timeoutMs: 5000, retry: { attempts: 1, backoffMs: 0, jitter: 0 } }),
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipAccount,
    });
    const ack = await sub.submit({ kind: 'bundle', signedTxs: [new Uint8Array([1])], tipLamports: 10_000n });
    expect(ack.bundleId).toBe('bundle-uuid-abc');
  });

  it('rejects non-bundle payloads', async () => {
    const sub = new JitoHttpSubmitter({
      httpClient: new HttpClient({ timeoutMs: 5000, retry: { attempts: 1, backoffMs: 0, jitter: 0 } }),
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipAccount,
    });
    await expect(
      sub.submit({ kind: 'tx', signedTx: new Uint8Array([1]) }),
    ).rejects.toThrow('JitoHttpSubmitter only handles bundle payloads');
  });

  it('throws on JSON-RPC error response', async () => {
    server.use(
      http.post('https://mainnet.block-engine.jito.wtf/api/v1/bundles', async () =>
        HttpResponse.json({ error: { message: 'bundle rejected: duplicate' } }),
      ),
    );
    const sub = new JitoHttpSubmitter({
      httpClient: new HttpClient({ timeoutMs: 5000, retry: { attempts: 1, backoffMs: 0, jitter: 0 } }),
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipAccount,
    });
    await expect(
      sub.submit({ kind: 'bundle', signedTxs: [new Uint8Array([2])], tipLamports: 5_000n }),
    ).rejects.toThrow('jito-http error: bundle rejected: duplicate');
    // Reset to default handler
    server.resetHandlers();
  });

  it('reports healthy with lastOkAt after successful submit', async () => {
    const sub = new JitoHttpSubmitter({
      httpClient: new HttpClient({ timeoutMs: 5000, retry: { attempts: 1, backoffMs: 0, jitter: 0 } }),
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipAccount,
    });
    expect(sub.health().state).toBe('healthy');
    expect(sub.health().lastOkAt).toBe(0);
    const before = Date.now();
    await sub.submit({ kind: 'bundle', signedTxs: [new Uint8Array([3])], tipLamports: 1_000n });
    const h = sub.health();
    expect(h.state).toBe('healthy');
    expect(h.lastOkAt).toBeGreaterThanOrEqual(before);
  });

  it('sets Authorization header when authToken is provided', async () => {
    let capturedAuthHeader: string | null = null;
    server.use(
      http.post('https://mainnet.block-engine.jito.wtf/api/v1/bundles', async ({ request }) => {
        capturedAuthHeader = request.headers.get('Authorization');
        return HttpResponse.json({ result: 'bundle-with-auth' });
      }),
    );
    const sub = new JitoHttpSubmitter({
      httpClient: new HttpClient({ timeoutMs: 5000, retry: { attempts: 1, backoffMs: 0, jitter: 0 } }),
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipAccount,
      authToken: 'my-secret-token',
    });
    const ack = await sub.submit({ kind: 'bundle', signedTxs: [new Uint8Array([4])], tipLamports: 1_000n });
    expect(ack.bundleId).toBe('bundle-with-auth');
    expect(capturedAuthHeader).toBe('Bearer my-secret-token');
    server.resetHandlers();
  });
});
