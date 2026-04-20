import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { JitoGrpcSubmitter } from './jito-grpc.js';
import { PINNED_COMMIT } from '../proto/load.js';
import { startFakeJitoServer } from '../../tests/helpers/jito-fake-server.js';

let server: Awaited<ReturnType<typeof startFakeJitoServer>>;

beforeAll(async () => {
  server = await startFakeJitoServer();
});

afterAll(async () => {
  await server.shutdown();
});

const tipAccount = PublicKey.fromBase58('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5');

describe('JitoGrpcSubmitter', () => {
  it('sends a bundle via gRPC and receives a UUID', async () => {
    const sub = new JitoGrpcSubmitter({
      grpcEndpoint: `127.0.0.1:${server.port}`,
      tipAccount,
    });
    const ack = await sub.submit({
      kind: 'bundle',
      signedTxs: [new Uint8Array([1, 2, 3])],
      tipLamports: 10_000n,
    });
    expect(ack.bundleId).toBe('fake-bundle-uuid');
    expect(ack.kind).toBe('bundle');
    expect(ack.submitterUsed).toBe('jito-grpc');
    expect(server.receivedBundles).toHaveLength(1);
  });

  it('rejects non-bundle payloads', async () => {
    const sub = new JitoGrpcSubmitter({
      grpcEndpoint: `127.0.0.1:${server.port}`,
      tipAccount,
    });
    await expect(
      sub.submit({ kind: 'tx', signedTx: new Uint8Array([1]) }),
    ).rejects.toThrow('JitoGrpcSubmitter only handles bundle payloads');
  });

  it('updates health.lastOkAt after a successful submit', async () => {
    const sub = new JitoGrpcSubmitter({
      grpcEndpoint: `127.0.0.1:${server.port}`,
      tipAccount,
    });
    expect(sub.health().state).toBe('healthy');
    expect(sub.health().lastOkAt).toBe(0);
    const before = Date.now();
    await sub.submit({
      kind: 'bundle',
      signedTxs: [new Uint8Array([9])],
      tipLamports: 1_000n,
    });
    const h = sub.health();
    expect(h.state).toBe('healthy');
    expect(h.lastOkAt).toBeGreaterThanOrEqual(before);
  });

  it('throws on proto commit mismatch', () => {
    expect(
      () =>
        new JitoGrpcSubmitter({
          grpcEndpoint: `127.0.0.1:${server.port}`,
          tipAccount,
          protoCommit: 'deadbeef',
        }),
    ).toThrow(`Jito proto commit mismatch: expected ${PINNED_COMMIT}, got deadbeef`);
  });

  it('accepts the correct pinned proto commit', async () => {
    const sub = new JitoGrpcSubmitter({
      grpcEndpoint: `127.0.0.1:${server.port}`,
      tipAccount,
      protoCommit: PINNED_COMMIT,
    });
    const ack = await sub.submit({
      kind: 'bundle',
      signedTxs: [new Uint8Array([7, 8])],
      tipLamports: 5_000n,
    });
    expect(ack.bundleId).toBe('fake-bundle-uuid');
  });
});
