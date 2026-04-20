import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HttpClient, PublicKey } from '@ap3x/solana-core';
import { JitoHttpSubmitter, JitoGrpcSubmitter } from '@ap3x/solana-executor';
import { startFakeJitoServer } from './helpers/jito-fake-server.js';

const server = setupServer(
  http.post('https://mainnet.block-engine.jito.wtf/api/v1/bundles', async () =>
    HttpResponse.json({ result: 'fake-bundle-uuid' }),
  ),
);
beforeAll(() => server.listen());
afterAll(() => server.close());

describe('gate 9: Jito HTTP/gRPC parity', () => {
  it('both submitters return structurally-equivalent ack for same input', async () => {
    const grpcServer = await startFakeJitoServer();
    try {
      const tipAccount = PublicKey.fromBase58('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');
      const httpSub = new JitoHttpSubmitter({
        httpClient: new HttpClient({ timeoutMs: 5000, retry: { attempts: 1, backoffMs: 0, jitter: 0 } }),
        blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
        tipAccount,
      });
      const grpcSub = new JitoGrpcSubmitter({
        grpcEndpoint: `127.0.0.1:${grpcServer.port}`,
        tipAccount,
      });

      const payload = {
        kind: 'bundle' as const,
        signedTxs: [new Uint8Array([1, 2, 3])],
        tipLamports: 10_000n,
      };
      const httpAck = await httpSub.submit(payload);
      const grpcAck = await grpcSub.submit(payload);

      expect(Object.keys(httpAck).sort()).toEqual(Object.keys(grpcAck).sort());
      expect(httpAck.kind).toBe('bundle');
      expect(grpcAck.kind).toBe('bundle');
      expect(httpAck.bundleId).toBeDefined();
      expect(grpcAck.bundleId).toBeDefined();
    } finally {
      await grpcServer.shutdown();
    }
  });
});
