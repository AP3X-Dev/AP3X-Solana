/**
 * WebSocket transaction streams — two ways to receive transactions that touch
 * a set of programs, both delivering the same {@link StreamedTransaction}:
 *
 *   - {@link subscribeHeliusTransactions}: Helius Enhanced WebSockets
 *     `transactionSubscribe`. One subscription covers every program
 *     (`accountInclude`), failed transactions are filtered server-side.
 *     Needs a paid Helius plan.
 *   - {@link subscribeProgramLogs}: standard Solana `logsSubscribe`, which
 *     any RPC node serves. `mentions` takes a single address, so this opens
 *     one subscription per program on one socket and de-duplicates
 *     transactions that mention several of them.
 *
 * Both resolve once every subscription is acknowledged on the first
 * connection and reject if that fails (bad URL, plan without the method), so
 * a caller can fall back to the other. After that, a dropped socket
 * reconnects with exponential backoff, re-subscribes, and reports
 * `onReconnect(lastSlot)` so the caller can backfill the gap.
 *
 * `ws` is a permitted dependency for the same reason grpc-js is in
 * geyser-client: Node 20 has no built-in WebSocket client.
 */

import WebSocket from 'ws';

export type StreamCommitment = 'processed' | 'confirmed' | 'finalized';

/** One transaction as delivered by either stream. */
export interface StreamedTransaction {
  signature: string;
  slot: number;
  /** Transaction error, `null` when it succeeded. */
  err: unknown;
  logs: string[];
  /** Local receive time, epoch ms. */
  receivedAt: number;
  /** The whole transaction, when the stream sends it (`transactionSubscribe`; `logsSubscribe` does not). */
  full?: FullTransaction;
}

/** A transaction as the chain stored it: wire bytes plus the parts of its meta that say who paid and what ran. */
export interface FullTransaction {
  /** Wire bytes: signatures, then the message. */
  bytes: Uint8Array;
  /** Network fee paid, lamports. */
  fee: number;
  /** Lookup-table addresses the message loaded, resolved, in order (base58). */
  loadedAddresses: { writable: string[]; readonly: string[] };
  /** Inner (CPI) instructions by top-level index; account and program indexes into the resolved keys, data base58. */
  innerInstructions: Array<{ index: number; instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }> }>;
}

export interface TxStreamHandlers {
  onTransaction(tx: StreamedTransaction): void;
  /** Re-subscribed after a drop. `lastSlot` is the last slot seen before it. */
  onReconnect?(lastSlot: number | null): void;
  /** The socket dropped; a reconnect is scheduled. */
  onDisconnect?(error: Error): void;
  onError?(error: Error): void;
}

export interface TxStream {
  close(): void;
}

export interface TxStreamOptions {
  /** `wss://` RPC URL, including any API key. */
  url: string;
  commitment?: StreamCommitment;
  /** Keepalive ping interval. Helius drops sockets idle for ~1 minute. Default 30s. */
  pingIntervalMs?: number;
  /** First reconnect delay, doubled per failed attempt up to `maxReconnectDelayMs`. Default 500. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface HeliusTransactionStreamOptions extends TxStreamOptions {
  /** Transactions touching any of these addresses (base58). */
  accountInclude: string[];
}

export interface ProgramLogsStreamOptions extends TxStreamOptions {
  /** Transactions mentioning any of these programs (base58). */
  programIds: string[];
}

/** Helius Enhanced WebSockets `transactionSubscribe`. */
export function subscribeHeliusTransactions(
  opts: HeliusTransactionStreamOptions,
  handlers: TxStreamHandlers,
): Promise<TxStream> {
  const request = {
    method: 'transactionSubscribe',
    params: [
      { accountInclude: opts.accountInclude, vote: false, failed: false },
      {
        commitment: opts.commitment ?? 'confirmed',
        encoding: 'base64',
        transactionDetails: 'full',
        showRewards: false,
        maxSupportedTransactionVersion: 1,
      },
    ],
  };
  return openStream(opts, [request], handlers, (method, result) => {
    if (method !== 'transactionNotification') return null;
    const r = result as {
      signature: string;
      slot: number;
      transaction?: {
        transaction?: [string, string] | string;
        meta?: {
          err?: unknown;
          logMessages?: string[] | null;
          fee?: number;
          loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
          innerInstructions?: FullTransaction['innerInstructions'] | null;
        };
      };
    };
    const meta = r.transaction?.meta;
    const wire = r.transaction?.transaction;
    const b64 = Array.isArray(wire) ? wire[0] : wire;
    const full: FullTransaction | undefined = b64 && meta
      ? {
          bytes: Uint8Array.from(Buffer.from(b64, 'base64')),
          fee: meta.fee ?? 0,
          loadedAddresses: { writable: meta.loadedAddresses?.writable ?? [], readonly: meta.loadedAddresses?.readonly ?? [] },
          innerInstructions: meta.innerInstructions ?? [],
        }
      : undefined;
    return { signature: r.signature, slot: r.slot, err: meta?.err ?? null, logs: meta?.logMessages ?? [], ...(full ? { full } : {}) };
  });
}

/** Standard `logsSubscribe`, one `mentions` subscription per program. */
export function subscribeProgramLogs(opts: ProgramLogsStreamOptions, handlers: TxStreamHandlers): Promise<TxStream> {
  const requests = opts.programIds.map((id) => ({
    method: 'logsSubscribe',
    params: [{ mentions: [id] }, { commitment: opts.commitment ?? 'confirmed' }],
  }));
  const seen = new RecentSet(10_000);
  return openStream(opts, requests, handlers, (method, result) => {
    if (method !== 'logsNotification') return null;
    const r = result as { context: { slot: number }; value: { signature: string; err: unknown; logs: string[] | null } };
    if (!seen.add(r.value.signature)) return null;
    return { signature: r.value.signature, slot: r.context.slot, err: r.value.err ?? null, logs: r.value.logs ?? [] };
  });
}

type Parse = (method: string, result: unknown) => Omit<StreamedTransaction, 'receivedAt'> | null;

interface RpcRequest {
  method: string;
  params: unknown[];
}

function openStream(
  opts: TxStreamOptions,
  requests: RpcRequest[],
  handlers: TxStreamHandlers,
  parse: Parse,
): Promise<TxStream> {
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
  const baseDelay = opts.reconnectDelayMs ?? 500;
  const maxDelay = opts.maxReconnectDelayMs ?? 30_000;

  let ws: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let started = false;
  let attempts = 0;
  let lastSlot: number | null = null;

  const stream: TxStream = {
    close() {
      closed = true;
      if (ping) clearInterval(ping);
      if (retry) clearTimeout(retry);
      ws?.removeAllListeners();
      ws?.on('error', () => {});
      ws?.terminate();
    },
  };

  return new Promise<TxStream>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (closed) return;
      if (ping) clearInterval(ping);
      ws?.removeAllListeners();
      ws?.on('error', () => {});
      ws?.terminate();
      if (!started) {
        closed = true;
        reject(error);
        return;
      }
      handlers.onDisconnect?.(error);
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempts++);
      retry = setTimeout(connect, delay);
    };

    const connect = (): void => {
      let acked = 0;
      const socket = new WebSocket(opts.url);
      ws = socket;
      socket.on('open', () => {
        requests.forEach((r, i) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...r })));
        ping = setInterval(() => socket.ping(), pingIntervalMs);
      });
      socket.on('message', (raw) => {
        const receivedAt = Date.now();
        let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { result?: unknown } };
        try {
          msg = JSON.parse(raw.toString()) as typeof msg;
        } catch {
          handlers.onError?.(new Error('unparseable stream message'));
          return;
        }
        if (msg.id !== undefined) {
          if (msg.error) return fail(new Error(`subscribe rejected: ${msg.error.message ?? 'unknown error'}`));
          if (++acked < requests.length) return;
          attempts = 0;
          if (started) handlers.onReconnect?.(lastSlot);
          else {
            started = true;
            resolve(stream);
          }
          return;
        }
        if (!msg.method || !msg.params) return;
        let tx;
        try {
          tx = parse(msg.method, msg.params.result);
        } catch (err) {
          handlers.onError?.(err as Error);
          return;
        }
        if (!tx) return;
        if (lastSlot === null || tx.slot > lastSlot) lastSlot = tx.slot;
        handlers.onTransaction({ ...tx, receivedAt });
      });
      socket.on('error', (err) => fail(err));
      socket.on('close', (code) => fail(new Error(`socket closed (${code})`)));
    };

    connect();
  });
}

/** Insertion-ordered set that forgets its oldest entries past `capacity`. */
class RecentSet {
  private readonly items = new Set<string>();
  constructor(private readonly capacity: number) {}

  /** False when `key` was already present. */
  add(key: string): boolean {
    if (this.items.has(key)) return false;
    this.items.add(key);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next().value as string;
      this.items.delete(oldest);
    }
    return true;
  }
}
