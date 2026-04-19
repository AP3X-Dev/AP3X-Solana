/**
 * GeyserClient — Yellowstone gRPC Geyser subscriber.
 *
 * Per spec Section 3.2 the client:
 *
 *   - Opens a bidirectional gRPC stream against a Yellowstone Geyser endpoint
 *     (https://github.com/rpcpool/yellowstone-grpc). The proto is vendored
 *     alongside this file in `./proto/yellowstone.proto`, pinned to an
 *     upstream commit.
 *   - Writes a `SubscribeRequest` message once on open and delivers
 *     `SubscribeUpdate` messages to a user-supplied handler one at a time,
 *     awaiting the handler between updates. This gives the handler back-
 *     pressure: a slow consumer can't get swamped.
 *   - Caps the in-memory queue at `queueCapacity` (default 1000) — when the
 *     handler can't keep up, the OLDEST pending update is dropped to keep the
 *     newest. A real-time trading agent cares about "right now"; stale
 *     updates are not worth blocking on. Drops are surfaced via a `'dropped'`
 *     event carrying a cumulative count, so callers can see backpressure
 *     pressure rather than have it hidden.
 *   - Detects slot gaps on `SubscribeUpdateSlot` messages: if the current
 *     slot > lastSeenSlot + 1, it emits a `'gap'` event with `{from, to}`
 *     (inclusive-exclusive: `from` = first missing slot, `to` = the slot we
 *     just saw) and calls the optional `onGap(from, to)` callback so a
 *     historical-backfill worker (T16) can refill the gap.
 *   - Persists a checkpoint (lastSlot, updateCount, timestamp) to an injected
 *     `CheckpointStore` every `checkpointEvery` updates (default 100). On
 *     reconnect, the checkpoint is loaded and its `lastSlot` seeds the gap
 *     detector so a restart still sees the jump as a gap.
 *
 * Design choices, called out:
 *
 *   - We use `@grpc/proto-loader` + `@grpc/grpc-js` rather than vendored
 *     `protobufjs` static code. Both packages are permitted exceptions to
 *     the zero-ecosystem-deps rule because Yellowstone's bidirectional
 *     streaming gRPC fundamentally requires an HTTP/2 gRPC client and a
 *     protobuf codec. They're NOT Solana SDK packages — no `@solana/*` or
 *     `@metaplex-foundation/*` dependency enters via this path.
 *
 *   - The client exposes an `EventEmitter`-shaped `Subscription` handle
 *     rather than a raw stream. Callers register `'update'`, `'dropped'`,
 *     `'gap'`, `'error'`, and `'closed'` listeners. The handler function
 *     supplied to `subscribe()` is a SEPARATE channel: the update is passed
 *     to the handler first, with full async back-pressure, and THEN the
 *     `'update'` event fires for any purely-reactive listeners (metrics,
 *     logging). If a listener throws, it is caught and re-emitted as
 *     `'error'` — we do not let a faulty observer take down the stream.
 *
 *   - The queue is a simple ring with drop-oldest semantics. More exotic
 *     structures (priority queues, dedup by slot) are easy to swap in later
 *     but premature here; substrate-level backpressure just needs to not
 *     OOM and not block the gRPC receive path.
 *
 *   - Slot-gap detection happens on slot updates only. Non-slot updates
 *     (account, transaction, block) carry slot numbers too but those slots
 *     aren't guaranteed to arrive in monotonic order — we can get an
 *     account update for slot 100 after a slot update for slot 101. Using
 *     slot updates as the timeline source-of-truth keeps the detector
 *     simple and correct.
 *
 *   - Proto path resolution: in the compiled package, `__dirname` points to
 *     `dist/`, and `tsup.config.ts` copies `src/proto/*.proto` to
 *     `dist/proto/`. In Vitest, the resolver finds them relative to the
 *     source file via the TypeScript source path. We let the caller
 *     override via `protoPath` for exotic deploys (e.g. bundlers that
 *     don't preserve the relative layout).
 */

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CheckpointStore, Checkpoint } from './checkpoint-store';

// ---------------------------------------------------------------------------
// Proto path resolution
// ---------------------------------------------------------------------------

/**
 * CJS-safe shim around `import.meta.url`. In ESM this returns the module
 * URL; in CJS (`__filename` defined) it returns the absolute path. We
 * extract it behind a typeof guard so esbuild's CJS build doesn't warn
 * about an empty `import.meta`.
 */
export function resolveCreateRequireBase(): string {
  if (typeof __filename !== 'undefined') return __filename;
  // ESM path. We read `import.meta.url` through a Function indirection so
  // esbuild's CJS build doesn't try to substitute the property and emit a
  // spurious "import.meta is empty in CJS" warning — that branch is
  // unreachable in CJS (guarded by the `__filename` check above), but
  // esbuild's static analysis doesn't prove that.
  // eslint-disable-next-line no-new-func
  const getMetaUrl = new Function('return import.meta.url') as () => string;
  return getMetaUrl();
}

/**
 * Resolve the proto directory for the current bundle layout. In ESM builds
 * `__dirname` isn't a bound global, so we derive it from `import.meta.url`
 * when available; in CJS builds `__dirname` already points at the file's
 * directory. This function is exported so tests can assert it finds a
 * plausible proto file.
 */
export function resolveProtoDir(): string {
  let here: string;
  if (typeof __dirname !== 'undefined') {
    here = __dirname;
  } else {
    // ESM: derive dirname from import.meta.url. Guarded to keep esbuild's
    // CJS output warning-free (the else branch is never emitted there).
    const url = resolveCreateRequireBase();
    here = url.startsWith('file:') ? dirname(fileURLToPath(url)) : dirname(url);
  }

  // First try `./proto` (dev: src/proto/, dist: dist/proto/). Fall back to
  // walking one level up (useful if the file is bundled flat and the proto/
  // dir sits next to the bundle root).
  const candidates = [resolve(here, 'proto'), resolve(here, '..', 'proto')];
  for (const cand of candidates) {
    if (existsSync(resolve(cand, 'yellowstone.proto'))) return cand;
  }
  // If neither candidate exists, return the primary anyway — the loader will
  // fail with a clear error pointing at the missing file.
  return candidates[0]!;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Yellowstone endpoint descriptor. */
export interface GeyserEndpoint {
  /** gRPC URL, e.g. `grpc.mainnet.helius-rpc.com:443`. */
  url: string;
  /** Bearer token for providers that authenticate with x-token metadata. */
  token?: string;
  /**
   * Use insecure (plaintext) channel. Defaults to `false` — production
   * Yellowstone endpoints are TLS. Tests use insecure loopback servers.
   */
  insecure?: boolean;
}

export interface GeyserClientOptions {
  endpoint: GeyserEndpoint;
  /** Optional checkpoint persistence. */
  checkpointStore?: CheckpointStore;
  /** Key passed to the checkpoint store; defaults to the endpoint URL. */
  checkpointKey?: string;
  /** Bounded queue capacity. Defaults to 1000. */
  queueCapacity?: number;
  /** Persist a checkpoint every N processed updates. Defaults to 100. */
  checkpointEvery?: number;
  /** Called when a slot gap is detected, typically to trigger backfill. */
  onGap?: (from: number, to: number) => void | Promise<void>;
  /**
   * Proto file absolute path override. Only needed for exotic bundlers.
   * Defaults to `<resolveProtoDir()>/yellowstone.proto`.
   */
  protoPath?: string;
  /** Injectable clock for deterministic checkpoint timestamps. */
  now?: () => number;
  /**
   * Injectable gRPC module factory. Tests inject a stub so we don't touch
   * the real network. In production, leave unset — the default lazy-loads
   * `@grpc/grpc-js` and `@grpc/proto-loader`.
   */
  grpc?: GrpcAdapter;
}

/**
 * Typed `SubscribeRequest` input. Narrower than the full proto — we expose
 * the subset that early callers (pumpfun-signals, the sample watcher) use.
 * Additional fields can be added here without breaking API stability.
 */
export interface SubscribeRequest {
  accounts?: Record<
    string,
    {
      account?: string[];
      owner?: string[];
    }
  >;
  slots?: Record<
    string,
    {
      filterByCommitment?: boolean;
      interslotUpdates?: boolean;
    }
  >;
  transactions?: Record<
    string,
    {
      vote?: boolean;
      failed?: boolean;
      signature?: string;
      accountInclude?: string[];
      accountExclude?: string[];
      accountRequired?: string[];
    }
  >;
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Geyser update envelope. Deliberately loose-typed — the proto's `oneof`
 * ships as a union of variant keys plus the payload under each key, and
 * downstream decoders in `solana-events` will narrow per-variant. Keeping
 * it as a typed record here avoids shipping a generated types file that
 * would have to be regenerated whenever the upstream proto moves.
 */
export type GeyserUpdate = {
  filters?: string[];
  createdAt?: unknown;
} & Partial<{
  account: { slot?: string | number; [k: string]: unknown };
  slot: {
    slot?: string | number;
    parent?: string | number;
    status?: number;
    [k: string]: unknown;
  };
  transaction: { slot?: string | number; [k: string]: unknown };
  transactionStatus: { slot?: string | number; [k: string]: unknown };
  block: { slot?: string | number; [k: string]: unknown };
  blockMeta: { slot?: string | number; [k: string]: unknown };
  entry: { slot?: string | number; [k: string]: unknown };
  ping: Record<string, unknown>;
  pong: { id?: number; [k: string]: unknown };
}>;

export interface DroppedEvent {
  /** Cumulative drop count over the life of this subscription. */
  count: number;
  /** ISO timestamp of the most recent drop. */
  since: string;
}

export interface GapEvent {
  /** First missing slot (inclusive). */
  from: number;
  /** Slot we just observed (exclusive of the gap). */
  to: number;
}

export interface Subscription extends EventEmitter {
  /** Terminate the stream. Safe to call multiple times. */
  close(): void;
  /** The loaded-from-store checkpoint, or `null` if none existed. */
  loadedCheckpoint(): Checkpoint | null;
}

// ---------------------------------------------------------------------------
// gRPC adapter — the surface the GeyserClient actually touches
// ---------------------------------------------------------------------------

/**
 * Minimal abstraction over `@grpc/grpc-js` that the client actually uses.
 * Exposing this lets tests inject an in-process fake gRPC client without
 * pulling a real channel across a loopback socket — cheaper and more
 * deterministic under Vitest.
 */
export interface GrpcAdapter {
  /**
   * Construct a client bound to the given endpoint. Returns an object
   * whose `subscribe()` method opens a bidirectional stream.
   */
  createClient(endpoint: GeyserEndpoint, protoPath: string): GrpcClientHandle;
}

export interface GrpcClientHandle {
  subscribe(): GrpcDuplexStream;
  close(): void;
}

export interface GrpcDuplexStream {
  on(event: 'data', cb: (update: GeyserUpdate) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
  on(event: 'end', cb: () => void): this;
  on(event: 'close', cb: () => void): this;
  write(message: unknown): boolean;
  end(): void;
  cancel(): void;
}

// ---------------------------------------------------------------------------
// Default gRPC adapter — lazy-loads @grpc/grpc-js + @grpc/proto-loader
// ---------------------------------------------------------------------------

/**
 * The default adapter. Not invoked (and therefore neither module is loaded)
 * unless `subscribe()` is actually called — so consumers that only import
 * types pay no startup cost.
 */
export const defaultGrpcAdapter: GrpcAdapter = {
  createClient(endpoint, protoPath) {
    // `createRequire` lets us load CJS-only modules from ESM without a
    // top-level static import that would hit every consumer of the package
    // even if they never instantiate a GeyserClient. The base URL is a
    // file:// URL in ESM (`import.meta.url`) and an absolute path in CJS
    // (`__filename`). We indirect through a helper so esbuild's CJS build
    // never sees a direct `import.meta` reference — otherwise it warns
    // that "import.meta is empty in CJS," which is benign here (the
    // branch is unreachable in CJS) but noisy.
    const base = resolveCreateRequireBase();
    const req = createRequire(base);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const grpc = req('@grpc/grpc-js') as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const protoLoader = req('@grpc/proto-loader') as any;

    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: false, // camelCase field names — idiomatic JS
      longs: String, // u64 as JS strings — BigInt support is patchy in proto-loader
      enums: Number,
      defaults: true,
      oneofs: true,
      // The main proto `import public "solana-storage.proto";` needs the
      // same directory on the include path; pass it explicitly so the
      // loader finds the sibling file regardless of cwd.
      includeDirs: [dirname(protoPath)],
    });
    const loaded = grpc.loadPackageDefinition(packageDefinition);
    const GeyserService = loaded.geyser.Geyser;

    const creds = endpoint.insecure
      ? grpc.credentials.createInsecure()
      : grpc.credentials.combineChannelCredentials(
          grpc.credentials.createSsl(),
          grpc.credentials.createFromMetadataGenerator(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (_: unknown, callback: (err: Error | null, md?: any) => void) => {
              const md = new grpc.Metadata();
              if (endpoint.token) md.add('x-token', endpoint.token);
              callback(null, md);
            },
          ),
        );

    const client = new GeyserService(endpoint.url, creds);
    return {
      subscribe: () => client.subscribe() as GrpcDuplexStream,
      close: () => client.close(),
    };
  },
};

// ---------------------------------------------------------------------------
// GeyserClient
// ---------------------------------------------------------------------------

const DEFAULT_QUEUE_CAPACITY = 1000;
const DEFAULT_CHECKPOINT_EVERY = 100;

export class GeyserClient {
  readonly #endpoint: GeyserEndpoint;
  readonly #store: CheckpointStore | undefined;
  readonly #checkpointKey: string;
  readonly #queueCapacity: number;
  readonly #checkpointEvery: number;
  readonly #onGap: ((from: number, to: number) => void | Promise<void>) | undefined;
  readonly #protoPath: string;
  readonly #now: () => number;
  readonly #grpc: GrpcAdapter;

  constructor(opts: GeyserClientOptions) {
    if (!opts.endpoint?.url) {
      throw new TypeError('GeyserClient requires an endpoint URL');
    }
    const queueCapacity = opts.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
    const checkpointEvery = opts.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY;
    if (queueCapacity < 1) {
      throw new RangeError('GeyserClient: queueCapacity must be >= 1');
    }
    if (checkpointEvery < 1) {
      throw new RangeError('GeyserClient: checkpointEvery must be >= 1');
    }

    this.#endpoint = opts.endpoint;
    this.#store = opts.checkpointStore;
    this.#checkpointKey = opts.checkpointKey ?? opts.endpoint.url;
    this.#queueCapacity = queueCapacity;
    this.#checkpointEvery = checkpointEvery;
    this.#onGap = opts.onGap;
    this.#protoPath =
      opts.protoPath ?? resolve(resolveProtoDir(), 'yellowstone.proto');
    this.#now = opts.now ?? Date.now;
    this.#grpc = opts.grpc ?? defaultGrpcAdapter;
  }

  /**
   * Open a subscription. The returned `Subscription` is an EventEmitter —
   * listen on `'update' | 'dropped' | 'gap' | 'error' | 'closed'`. Call
   * `close()` to tear down the stream.
   *
   * `handler(update)` is invoked sequentially with backpressure: the client
   * awaits the handler before taking the next update off the queue.
   */
  subscribe(
    req: SubscribeRequest,
    handler: (update: GeyserUpdate) => void | Promise<void>,
  ): Subscription {
    const sub = new SubscriptionImpl(
      this.#endpoint,
      this.#grpc,
      this.#protoPath,
      req,
      handler,
      this.#queueCapacity,
      this.#checkpointEvery,
      this.#store,
      this.#checkpointKey,
      this.#onGap,
      this.#now,
    );
    sub.start();
    return sub;
  }
}

// ---------------------------------------------------------------------------
// Subscription — one live stream, with backpressure, gap detection, and
// checkpointing. Kept as a private class so the GeyserClient surface stays
// small.
// ---------------------------------------------------------------------------

class SubscriptionImpl extends EventEmitter implements Subscription {
  // Ring buffer state. `#queue` holds at most `#capacity` items. When a new
  // item arrives and the queue is full, the oldest is dropped.
  readonly #queue: GeyserUpdate[] = [];
  readonly #capacity: number;
  readonly #checkpointEvery: number;
  readonly #store: CheckpointStore | undefined;
  readonly #checkpointKey: string;
  readonly #onGap:
    | ((from: number, to: number) => void | Promise<void>)
    | undefined;
  readonly #now: () => number;

  #lastSlot = -1; // -1 means "no slot seen yet"
  #updateCount = 0;
  #droppedCount = 0;
  #loadedCheckpoint: Checkpoint | null = null;

  // Concurrency control for the single-consumer drain loop.
  #draining = false;
  #closed = false;
  #stream: GrpcDuplexStream | undefined;
  #clientHandle: GrpcClientHandle | undefined;

  readonly #endpoint: GeyserEndpoint;
  readonly #grpc: GrpcAdapter;
  readonly #protoPath: string;
  readonly #req: SubscribeRequest;
  readonly #handler: (update: GeyserUpdate) => void | Promise<void>;

  constructor(
    endpoint: GeyserEndpoint,
    grpc: GrpcAdapter,
    protoPath: string,
    req: SubscribeRequest,
    handler: (update: GeyserUpdate) => void | Promise<void>,
    capacity: number,
    checkpointEvery: number,
    store: CheckpointStore | undefined,
    checkpointKey: string,
    onGap:
      | ((from: number, to: number) => void | Promise<void>)
      | undefined,
    now: () => number,
  ) {
    super();
    this.#endpoint = endpoint;
    this.#grpc = grpc;
    this.#protoPath = protoPath;
    this.#req = req;
    this.#handler = handler;
    this.#capacity = capacity;
    this.#checkpointEvery = checkpointEvery;
    this.#store = store;
    this.#checkpointKey = checkpointKey;
    this.#onGap = onGap;
    this.#now = now;
  }

  loadedCheckpoint(): Checkpoint | null {
    return this.#loadedCheckpoint;
  }

  /**
   * Start the stream. Async in spirit but returns synchronously so the
   * caller can attach event listeners before the first data arrives.
   */
  start(): void {
    // Load checkpoint first (fire-and-forget); if it resolves before data
    // arrives, the seeded slot participates in gap detection. If data beats
    // the load, the gap detector starts fresh and we accept that — the next
    // checkpoint write will correct any drift.
    if (this.#store) {
      void this.#store
        .load(this.#checkpointKey)
        .then((ckpt) => {
          if (ckpt && this.#lastSlot < 0) {
            this.#loadedCheckpoint = ckpt;
            this.#lastSlot = ckpt.lastSlot;
            this.#updateCount = ckpt.updateCount;
          }
        })
        .catch((err: Error) => {
          this.emit('error', err);
        });
    }

    // Open the stream. Errors on open are surfaced as 'error' events rather
    // than thrown — keeps the public API uniform (always an event) and lets
    // the caller attach error listeners before calling start().
    let handle: GrpcClientHandle;
    try {
      handle = this.#grpc.createClient(this.#endpoint, this.#protoPath);
    } catch (err) {
      queueMicrotask(() => this.emit('error', err as Error));
      return;
    }
    this.#clientHandle = handle;
    let stream: GrpcDuplexStream;
    try {
      stream = handle.subscribe();
    } catch (err) {
      queueMicrotask(() => this.emit('error', err as Error));
      return;
    }
    this.#stream = stream;

    stream.on('data', (update: GeyserUpdate) => {
      if (this.#closed) return;
      this.#enqueue(update);
      // Kick the drain loop; no-op if already draining.
      void this.#drain();
    });
    stream.on('error', (err: Error) => {
      if (this.#closed) return;
      this.emit('error', err);
    });
    stream.on('end', () => {
      this.#teardown();
    });
    stream.on('close', () => {
      this.#teardown();
    });

    // Send the subscribe request. Yellowstone wants it on the client→server
    // side of the bidi stream. Encode the typed TS shape into the proto's
    // repeated-map wire format.
    try {
      stream.write(encodeSubscribeRequest(this.#req));
    } catch (err) {
      queueMicrotask(() => this.emit('error', err as Error));
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Flush any pending drain before tearing the stream down. We don't
    // await — close() is synchronous — but we leave the drain loop alone,
    // it will observe #closed and exit cleanly.
    try {
      this.#stream?.cancel();
    } catch {
      // cancel() on an already-dead stream can throw; ignore.
    }
    try {
      this.#clientHandle?.close();
    } catch {
      // same story.
    }
    // Emit 'closed' on the next tick so callers that call close() inside
    // an event handler don't re-enter before their caller unwinds.
    queueMicrotask(() => this.emit('closed'));
  }

  #teardown(): void {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.emit('closed'));
  }

  /**
   * Push an update onto the bounded queue. If full, drop the oldest and
   * bump the dropped counter.
   */
  #enqueue(update: GeyserUpdate): void {
    if (this.#queue.length >= this.#capacity) {
      // Drop oldest. A ping update is as valid a drop victim as an
      // account update — prioritisation by variant is a policy we don't
      // want to bake in here.
      this.#queue.shift();
      this.#droppedCount += 1;
      this.emit('dropped', {
        count: this.#droppedCount,
        since: new Date(this.#now()).toISOString(),
      } satisfies DroppedEvent);
    }
    this.#queue.push(update);
  }

  /**
   * Drain the queue: for each item, detect gaps, await the handler,
   * checkpoint if due. Re-entrant safe via `#draining`. Exits on close
   * or empty queue.
   */
  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#closed && this.#queue.length > 0) {
        const update = this.#queue.shift()!;
        // Gap detection on slot updates ONLY — see file-level notes for why.
        if (update.slot && update.slot.slot !== undefined) {
          const slot = Number(update.slot.slot);
          if (this.#lastSlot >= 0 && slot > this.#lastSlot + 1) {
            const from = this.#lastSlot + 1;
            const to = slot;
            this.emit('gap', { from, to } satisfies GapEvent);
            if (this.#onGap) {
              try {
                await this.#onGap(from, to);
              } catch (err) {
                this.emit('error', err as Error);
              }
            }
          }
          if (slot > this.#lastSlot) this.#lastSlot = slot;
        }

        // Run the handler with backpressure. A throwing handler does not
        // stop the stream; we surface it as 'error' and continue.
        try {
          await this.#handler(update);
        } catch (err) {
          this.emit('error', err as Error);
        }
        // Reactive listeners see the update AFTER the handler has run, so
        // the ordering invariant is clear: handler commit-point first, then
        // observers. This matters for callers who use 'update' to update
        // dashboards — dashboards should reflect processed state.
        this.emit('update', update);

        this.#updateCount += 1;

        // Checkpoint every N processed updates. We only write if a store is
        // configured AND we have a real lastSlot; checkpointing slot=-1 is
        // meaningless.
        if (
          this.#store &&
          this.#lastSlot >= 0 &&
          this.#updateCount % this.#checkpointEvery === 0
        ) {
          const ckpt: Checkpoint = {
            lastSlot: this.#lastSlot,
            updateCount: this.#updateCount,
            timestamp: new Date(this.#now()).toISOString(),
          };
          try {
            await this.#store.save(this.#checkpointKey, ckpt);
          } catch (err) {
            this.emit('error', err as Error);
          }
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Request encoding
// ---------------------------------------------------------------------------

/**
 * Encode a typed `SubscribeRequest` into the wire shape proto-loader
 * expects. Primarily that means uppercasing the commitment level (proto
 * enums are `PROCESSED | CONFIRMED | FINALIZED`), and filling in default
 * `[]` arrays for repeated fields so `keepCase: false` → camelCase users
 * don't accidentally set a scalar where the proto wants a list.
 */
function encodeSubscribeRequest(req: SubscribeRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    accounts: req.accounts ?? {},
    slots: req.slots ?? {},
    transactions: req.transactions ?? {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
  };
  if (req.commitment) {
    out.commitment =
      req.commitment === 'processed'
        ? 0
        : req.commitment === 'confirmed'
          ? 1
          : 2;
  }
  return out;
}
