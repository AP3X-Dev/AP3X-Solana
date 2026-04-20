import * as grpc from '@grpc/grpc-js';
import { loadSearcherProto } from '../../src/proto/load.js';

export interface FakeJitoServer {
  port: number;
  shutdown(): Promise<void>;
  receivedBundles: any[];
}

export async function startFakeJitoServer(): Promise<FakeJitoServer> {
  const { SearcherService } = loadSearcherProto();
  const server = new grpc.Server();
  const received: any[] = [];

  server.addService(
    (SearcherService as any).service,
    {
      sendBundle: (call: any, cb: any) => {
        received.push(call.request);
        cb(null, { uuid: 'fake-bundle-uuid' });
      },
      getTipAccounts: (_call: any, cb: any) =>
        cb(null, { accounts: ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'] }),
    },
  );

  const port = await new Promise<number>((res, rej) => {
    server.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createInsecure(),
      (err, p) => {
        if (err) rej(err);
        else res(p);
      },
    );
  });

  return {
    port,
    shutdown: () => new Promise((res) => server.tryShutdown(() => res())),
    receivedBundles: received,
  };
}
