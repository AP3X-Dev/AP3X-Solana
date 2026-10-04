import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import { subscribeHeliusTransactions, subscribeProgramLogs, type StreamedTransaction, type TxStream } from './tx-stream';

interface Rpc {
  id: number;
  method: string;
  params: unknown[];
}

/** Loopback JSON-RPC server that acks every subscribe unless `reject` is set. */
async function server(opts: { reject?: string } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const requests: Rpc[] = [];
  const sockets: WebSocket[] = [];
  let pings = 0;
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('ping', () => pings++);
    ws.on('message', (raw) => {
      const req = JSON.parse(raw.toString()) as Rpc;
      requests.push(req);
      ws.send(
        JSON.stringify(
          opts.reject
            ? { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: opts.reject } }
            : { jsonrpc: '2.0', id: req.id, result: 100 + req.id },
        ),
      );
    });
  });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const last = () => sockets[sockets.length - 1]!;
  return {
    url,
    requests,
    sockets,
    pings: () => pings,
    notify: (method: string, result: unknown) =>
      last().send(JSON.stringify({ jsonrpc: '2.0', method, params: { subscription: 1, result } })),
    raw: (data: string) => last().send(data),
    close: () => new Promise<void>((r) => {
      for (const s of wss.clients) s.terminate();
      wss.close(() => r());
    }),
  };
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(opts?: { reject?: string }) {
  const s = await server(opts);
  cleanup.push(s.close);
  return s;
}

const keep = (stream: TxStream) => {
  cleanup.push(() => stream.close());
  return stream;
};

describe('subscribeHeliusTransactions', () => {
  it('subscribes once for all programs and delivers parsed transactions', async () => {
    const s = await setup();
    const got: StreamedTransaction[] = [];
    keep(await subscribeHeliusTransactions({ url: s.url, accountInclude: ['A', 'B'] }, { onTransaction: (t) => got.push(t) }));

    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.method).toBe('transactionSubscribe');
    expect(s.requests[0]!.params[0]).toEqual({ accountInclude: ['A', 'B'], vote: false, failed: false });
    expect(s.requests[0]!.params[1]).toMatchObject({ commitment: 'confirmed', transactionDetails: 'full' });

    s.notify('transactionNotification', {
      signature: 'sig1',
      slot: 42,
      transaction: {
        transaction: ['AQID', 'base64'],
        meta: { err: null, logMessages: ['Program X invoke [1]'], fee: 5000, loadedAddresses: { writable: ['W'], readonly: ['R'] },
          innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0, 1], data: '3Bxs4' }] }] },
      },
    });
    s.notify('transactionNotification', { signature: 'sig2', slot: 43, transaction: { meta: { logMessages: null } } });
    await until(() => got.length === 2);

    expect(got[0]).toMatchObject({ signature: 'sig1', slot: 42, err: null, logs: ['Program X invoke [1]'] });
    expect(got[0]!.receivedAt).toBeGreaterThan(0);
    expect(got[1]).toMatchObject({ signature: 'sig2', logs: [] });
    // The whole transaction comes through with the parts of its meta that matter; none when the stream sent none.
    expect(got[0]!.full).toEqual({ bytes: Uint8Array.from([1, 2, 3]), fee: 5000, loadedAddresses: { writable: ['W'], readonly: ['R'] },
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0, 1], data: '3Bxs4' }] }] });
    expect(got[1]!.full).toBeUndefined();
  });

  it('rejects when the provider refuses the subscription, so the caller can fall back', async () => {
    const s = await setup({ reject: 'Method not found' });
    await expect(
      subscribeHeliusTransactions({ url: s.url, accountInclude: ['A'] }, { onTransaction: () => {} }),
    ).rejects.toThrow('subscribe rejected: Method not found');
  });

  it('rejects when the endpoint is unreachable', async () => {
    const s = await setup();
    await s.close();
    await expect(
      subscribeHeliusTransactions({ url: s.url, accountInclude: ['A'] }, { onTransaction: () => {} }),
    ).rejects.toThrow();
  });
});

describe('subscribeProgramLogs', () => {
  it('opens one subscription per program and drops duplicate signatures', async () => {
    const s = await setup();
    const got: StreamedTransaction[] = [];
    keep(
      await subscribeProgramLogs(
        { url: s.url, programIds: ['P1', 'P2'], commitment: 'processed' },
        { onTransaction: (t) => got.push(t) },
      ),
    );

    expect(s.requests.map((r) => r.params[0])).toEqual([{ mentions: ['P1'] }, { mentions: ['P2'] }]);
    expect(s.requests[0]!.params[1]).toEqual({ commitment: 'processed' });

    const value = { signature: 'dup', err: null, logs: ['a'] };
    s.notify('logsNotification', { context: { slot: 7 }, value });
    s.notify('logsNotification', { context: { slot: 7 }, value });
    s.notify('logsNotification', { context: { slot: 8 }, value: { signature: 'bad', err: { InstructionError: [0, 'x'] }, logs: null } });
    s.notify('slotNotification', { slot: 9 });
    await until(() => got.length === 2);
    await new Promise((r) => setTimeout(r, 30));

    expect(got.map((t) => t.signature)).toEqual(['dup', 'bad']);
    expect(got[1]).toMatchObject({ slot: 8, err: { InstructionError: [0, 'x'] }, logs: [] });
  });
});

describe('connection lifecycle', () => {
  it('reconnects after a drop, re-subscribes, and reports the last slot seen', async () => {
    const s = await setup();
    const reconnects: Array<number | null> = [];
    let disconnects = 0;
    let n = 0;
    keep(
      await subscribeProgramLogs(
        { url: s.url, programIds: ['P1'], reconnectDelayMs: 10 },
        {
          onTransaction: () => n++,
          onDisconnect: () => disconnects++,
          onReconnect: (slot) => reconnects.push(slot),
        },
      ),
    );
    s.notify('logsNotification', { context: { slot: 55 }, value: { signature: 's', err: null, logs: [] } });
    await until(() => n === 1);

    s.sockets[0]!.terminate();
    await until(() => reconnects.length === 1);

    expect(disconnects).toBe(1);
    expect(reconnects).toEqual([55]);
    expect(s.requests).toHaveLength(2);
  });

  it('stops reconnecting once closed', async () => {
    const s = await setup();
    const stream = await subscribeProgramLogs({ url: s.url, programIds: ['P1'], reconnectDelayMs: 10 }, { onTransaction: () => {} });
    stream.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(s.requests).toHaveLength(1);
  });

  it('pings to keep the socket alive', async () => {
    const s = await setup();
    keep(await subscribeProgramLogs({ url: s.url, programIds: ['P1'], pingIntervalMs: 10 }, { onTransaction: () => {} }));
    await until(() => s.pings() >= 2);
  });

  it('reports unparseable messages without dropping the stream', async () => {
    const s = await setup();
    const errors: Error[] = [];
    const got: string[] = [];
    keep(
      await subscribeProgramLogs(
        { url: s.url, programIds: ['P1'] },
        { onTransaction: (t) => got.push(t.signature), onError: (e) => errors.push(e) },
      ),
    );
    s.raw('not json');
    s.notify('logsNotification', { context: { slot: 1 } });
    s.notify('logsNotification', { context: { slot: 2 }, value: { signature: 'ok', err: null, logs: [] } });
    await until(() => got.length === 1);
    expect(errors).toHaveLength(2);
  });
});
