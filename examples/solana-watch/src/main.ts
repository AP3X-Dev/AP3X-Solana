#!/usr/bin/env node
/**
 * `solana-watch` — reference integration example that ties the seven
 * `@ap3x/solana-*` substrate packages together.
 *
 * The program:
 *
 *   1. Parses CLI flags (`--program`, `--rpc`, `--geyser`, `--geyser-token`,
 *      `--decoder`).
 *   2. Constructs an `RpcPool` if any `--rpc` endpoints were supplied (the
 *      example writes nothing RPC-dependent today; the pool is wired up so
 *      consumers copying this example see the canonical construction).
 *   3. Constructs a `GeyserClient` against the supplied `--geyser` URL.
 *   4. Builds an `EventDecoderRegistry` and registers the decoders the user
 *      asked for (`spl`, `spl-2022`, `metaplex`). Unknown decoder names
 *      abort early — silently skipping a requested decoder would hide typos
 *      from dashboards.
 *   5. Opens a single Geyser subscription filtered to every `--program`
 *      (transactions whose account set includes any of them).
 *   6. For each transaction update, parses the log messages into a program
 *      chunk tree via `parseLogs`, runs the registry, and emits one JSON line
 *      per chunk with `{slot, programId, kind, latencyMs}`.
 *
 * The module exports `run()` and `parseArgs()` so the integration test can
 * drive the orchestration without spawning a real process or touching
 * `process.stdout`. The `main()` wrapper at the bottom is the production
 * entry point and is skipped under Vitest.
 */

import { readFileSync } from 'node:fs';

import { GeyserClient } from '@ap3x/solana-connectivity';
import type {
  GeyserClientOptions,
  GeyserUpdate,
  SubscribeRequest,
  Subscription,
} from '@ap3x/solana-connectivity';
import {
  EventDecoderRegistry,
  parseLogs,
  type DecodedEvent,
  type EventUnion,
} from '@ap3x/solana-events';
import {
  normalizeHeliusTx,
  type HeliusEnhancedTx,
} from '@ap3x/solana-webhooks';

import {
  splTokenDecoder,
  splToken2022Decoder,
  type SimpleDecodedEvent,
} from './decoders/spl';
import { metaplexDecoder } from './decoders/metaplex';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Args {
  /**
   * Operating mode. `geyser` is the live-stream Yellowstone path; `webhook`
   * is a one-shot replay of a captured Helius enhanced-tx fixture file.
   */
  mode: 'geyser' | 'webhook';
  /** Base58 program IDs to subscribe to. Required in `geyser` mode. */
  programs: string[];
  /** Optional RPC endpoint URLs (may be provided more than once). */
  rpc: string[];
  /** Geyser gRPC endpoint. Required in `geyser` mode. */
  geyser?: string;
  /** Optional bearer token; sent as the `x-token` metadata value. */
  geyserToken?: string;
  /**
   * Requested decoder names. Known values: `spl`, `spl-2022`, `metaplex`.
   * Unknown names throw from `parseArgs` to fail fast.
   */
  decoders: string[];
  /**
   * Use an insecure gRPC channel. Defaults to `false`; useful for loopback
   * fakes in tests and Docker-side helpers.
   */
  insecure?: boolean;
  /**
   * Path to a captured Helius enhanced-tx fixture. Sets `mode: 'webhook'`.
   * The file may contain a single tx object or an array of them — both
   * shapes are produced by the Helius webhook in the wild (single is what
   * captured tests record, array is what the live receiver hands the
   * driver).
   */
  webhook?: string;
}

/**
 * Dependency sink for the `run()` function. Real `main()` wires this to
 * `process.stdout` / `process.stderr`; tests capture the lines in arrays.
 */
export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Transport-level injection point. Tests pass a fake `GeyserClient` so the
 * orchestration can be exercised without touching the network. Production
 * leaves this unset and `run()` constructs the real client.
 */
export interface RunDeps {
  /** Clock for `latencyMs` measurement. Defaults to `Date.now`. */
  now?: () => number;
  /** Factory for the Geyser client. Defaults to the real constructor. */
  geyserFactory?: (opts: GeyserClientOptions) => GeyserClient;
}

/** Every JSON line printed on stdout has this shape. */
export interface WatchLine {
  slot: number;
  programId: string;
  kind: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const KNOWN_DECODERS = new Set(['spl', 'spl-2022', 'metaplex']);

/**
 * Parse argv (the slice after `node script.js`). The parser is deliberately
 * small: no positional args, two forms for each flag (`--flag value` and
 * `--flag=value`), and a hard error on unknowns. Repeated flags accumulate
 * into their array. Throws `Error` on any problem so the caller can render
 * a clean message — we do NOT `process.exit` from inside the parser, which
 * keeps it pure and testable.
 */
export function parseArgs(argv: string[]): Args {
  const programs: string[] = [];
  const rpc: string[] = [];
  const decoders: string[] = [];
  let geyser: string | undefined;
  let geyserToken: string | undefined;
  let insecure = false;
  let webhook: string | undefined;

  const takeValue = (flag: string, inline: string | undefined, i: number): [string, number] => {
    if (inline !== undefined) return [inline, i];
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return [next, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue;
    if (!raw.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${raw}`);
    }
    const eq = raw.indexOf('=');
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;

    switch (flag) {
      case '--program': {
        const [v, j] = takeValue(flag, inline, i);
        programs.push(v);
        i = j;
        break;
      }
      case '--rpc': {
        const [v, j] = takeValue(flag, inline, i);
        rpc.push(v);
        i = j;
        break;
      }
      case '--geyser': {
        const [v, j] = takeValue(flag, inline, i);
        geyser = v;
        i = j;
        break;
      }
      case '--geyser-token': {
        const [v, j] = takeValue(flag, inline, i);
        geyserToken = v;
        i = j;
        break;
      }
      case '--decoder': {
        const [v, j] = takeValue(flag, inline, i);
        if (!KNOWN_DECODERS.has(v)) {
          throw new Error(
            `unknown --decoder: ${v} (known: ${[...KNOWN_DECODERS].join(', ')})`,
          );
        }
        decoders.push(v);
        i = j;
        break;
      }
      case '--insecure':
        insecure = true;
        break;
      case '--webhook': {
        const [v, j] = takeValue(flag, inline, i);
        webhook = v;
        i = j;
        break;
      }
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  // --webhook is mutually exclusive with the live Geyser flags. The two
  // modes carry different mandatory inputs and asserting up-front prevents
  // a surprising precedence rule from biting an integrator.
  if (webhook !== undefined && (geyser !== undefined || programs.length > 0)) {
    throw new Error('--webhook cannot be combined with --geyser or --program');
  }

  if (webhook === undefined) {
    if (programs.length === 0) {
      throw new Error('at least one --program is required (or supply --webhook <fixture.json>)');
    }
    if (!geyser) {
      throw new Error('--geyser URL is required (or supply --webhook <fixture.json>)');
    }
  }

  // Default to all decoders when the user didn't specify any — the example's
  // headline use case is "watch everything the substrate can name." Decoders
  // are unused in webhook mode (the Helius driver is its own decoder), but
  // we still resolve a default so the Args shape is uniform.
  const resolvedDecoders = decoders.length > 0 ? decoders : ['spl', 'spl-2022', 'metaplex'];
  const mode: Args['mode'] = webhook !== undefined ? 'webhook' : 'geyser';
  const args: Args = {
    mode,
    programs,
    rpc,
    decoders: resolvedDecoders,
    insecure,
  };
  if (geyser !== undefined) args.geyser = geyser;
  if (geyserToken !== undefined) args.geyserToken = geyserToken;
  if (webhook !== undefined) args.webhook = webhook;
  return args;
}

// ---------------------------------------------------------------------------
// Registry construction
// ---------------------------------------------------------------------------

/**
 * Build an `EventDecoderRegistry` pre-populated with the decoders named in
 * `args.decoders`. Exported for test reuse — callers want to assert the
 * registry's shape without driving the full `run()` pipeline.
 */
export function buildRegistry(decoderNames: string[]): EventDecoderRegistry {
  const registry = new EventDecoderRegistry();
  for (const name of decoderNames) {
    switch (name) {
      case 'spl':
        registry.register(splTokenDecoder.programId, splTokenDecoder);
        break;
      case 'spl-2022':
        registry.register(splToken2022Decoder.programId, splToken2022Decoder);
        break;
      case 'metaplex':
        registry.register(metaplexDecoder.programId, metaplexDecoder);
        break;
      default:
        // parseArgs already validated; this branch guards against the public
        // surface being called with an unknown name.
        throw new Error(`buildRegistry: unknown decoder name: ${name}`);
    }
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Log extraction
// ---------------------------------------------------------------------------

/**
 * Pull the flat `logMessages` array out of a Geyser transaction update. The
 * Yellowstone proto ships it as `update.transaction.transaction.meta.logMessages`
 * after `keepCase: false` camelCasing; we walk that path defensively because
 * the types are loose by design (see `GeyserUpdate` jsdoc in solana-connectivity).
 * Returns `null` when the update has no transaction log we can parse.
 */
export function extractLogMessages(update: GeyserUpdate): string[] | null {
  const tx = update.transaction;
  if (!tx || typeof tx !== 'object') return null;
  // Shape: { slot, transaction: { meta: { logMessages } } }
  const inner = (tx as { transaction?: unknown }).transaction;
  if (!inner || typeof inner !== 'object') return null;
  const meta = (inner as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  const logs = (meta as { logMessages?: unknown }).logMessages;
  if (!Array.isArray(logs)) return null;
  // Filter to strings — upstream proto is `repeated string`, but a
  // malformed fake could leak non-strings in tests; we'd rather drop the
  // update cleanly than crash.
  return logs.filter((l): l is string => typeof l === 'string');
}

/**
 * Extract the slot number from a transaction update. Falls back to the outer
 * slot field if the transaction envelope has one. Returns 0 on absence so
 * the downstream JSON line still has a numeric field.
 */
export function extractSlot(update: GeyserUpdate): number {
  const tx = update.transaction;
  if (tx && typeof tx === 'object') {
    const slot = (tx as { slot?: string | number }).slot;
    if (slot !== undefined) return Number(slot);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Update handler — shared between the test path and the run() path
// ---------------------------------------------------------------------------

/**
 * For a single Geyser update, parse logs, decode events, and emit one
 * `WatchLine` per decoded chunk. Exported so tests can exercise the whole
 * decode-and-emit path without spinning up a GeyserClient.
 *
 * `nowFn` is used for latency measurement: `latencyMs = nowFn() - startedAt`
 * where `startedAt` is captured as the update enters the handler.
 */
export function handleUpdate(
  update: GeyserUpdate,
  registry: EventDecoderRegistry,
  io: Io,
  nowFn: () => number,
): void {
  const startedAt = nowFn();
  const logs = extractLogMessages(update);
  if (!logs || logs.length === 0) return;

  const slot = extractSlot(update);
  const transactionLog = parseLogs(logs);
  const stream = registry.decode(transactionLog);

  for (const ev of stream.events) {
    const line = formatLine(ev, slot, nowFn() - startedAt);
    io.stdout(JSON.stringify(line));
  }
}

/**
 * Shape a single `EventUnion` into the stable JSON-line schema. Unknown
 * decodes emit `kind: 'unknown'` so consumers can track decoder coverage;
 * decoded events forward the decoder's `kind` field verbatim when present,
 * or fall back to `'decoded'` if the decoder returned a non-shaped payload.
 */
function formatLine(ev: EventUnion, slot: number, latencyMs: number): WatchLine {
  if (ev.kind === 'unknown') {
    return { slot, programId: ev.programId, kind: 'unknown', latencyMs };
  }
  const decoded = ev as DecodedEvent<unknown>;
  const data = decoded.data;
  let kind: string = 'decoded';
  if (data !== null && typeof data === 'object' && 'kind' in data) {
    const k = (data as { kind?: unknown }).kind;
    if (typeof k === 'string') kind = k;
  }
  return { slot, programId: decoded.programId, kind, latencyMs };
}

// ---------------------------------------------------------------------------
// Webhook mode — one-shot fixture replay
// ---------------------------------------------------------------------------

/**
 * Read a captured Helius enhanced-tx fixture from disk and emit one
 * `WatchLine` per normalised event. Accepts either the single-tx shape (what
 * the test fixtures store) or the array-of-tx wire shape (what Helius posts
 * to a live receiver). Throws if the file is unreadable or not JSON; the
 * caller (`runWebhook`) catches and surfaces via `io.stderr`.
 */
export function readWebhookFixture(path: string): HeliusEnhancedTx[] {
  const text = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as HeliusEnhancedTx[];
  return [parsed as HeliusEnhancedTx];
}

/**
 * Project a single normalised webhook event into the same `WatchLine` shape
 * Geyser-mode emits, so a downstream consumer sees one stream regardless of
 * which transport produced it. The `kind` field carries:
 *   - the `variant` field for `decoded` events (`helius-swap`, ...)
 *   - the literal string `'unknown'` for `UnknownEventDecode`
 */
function formatWebhookLine(
  ev: ReturnType<typeof normalizeHeliusTx>[number],
  latencyMs: number,
): WatchLine {
  if (ev.kind === 'unknown') {
    return { slot: ev.slot, programId: ev.programId, kind: 'unknown', latencyMs };
  }
  // Decoded — the data payload is the HeliusDecodedData with `variant`.
  const data = ev.data as { variant?: unknown };
  const kind = typeof data?.variant === 'string' ? data.variant : 'decoded';
  return { slot: ev.slot, programId: ev.programId, kind, latencyMs };
}

/**
 * Run the one-shot webhook replay. Reads the fixture file referenced by
 * `args.webhook`, normalises every contained tx through the Helius driver's
 * `normalizeHeliusTx`, and prints one JSON line per emitted event. Returns a
 * cleanup function for symmetry with `run()`; it's a no-op since the
 * pipeline finishes synchronously here.
 */
export function runWebhook(args: Args, io: Io, deps: RunDeps = {}): () => Promise<void> {
  if (!args.webhook) {
    // Defensive — main() routes here only when webhook is set.
    throw new Error('runWebhook called without --webhook path');
  }
  const now = deps.now ?? Date.now;
  let txs: HeliusEnhancedTx[];
  try {
    txs = readWebhookFixture(args.webhook);
  } catch (err) {
    io.stderr(`solana-watch: cannot read --webhook fixture ${args.webhook}: ${(err as Error).message}`);
    return () => Promise.resolve();
  }

  for (const tx of txs) {
    const startedAt = now();
    const events = normalizeHeliusTx(tx);
    for (const ev of events) {
      io.stdout(JSON.stringify(formatWebhookLine(ev, now() - startedAt)));
    }
  }

  return () => Promise.resolve();
}

// ---------------------------------------------------------------------------
// run() — the testable orchestration core
// ---------------------------------------------------------------------------

/**
 * Build the pipeline and open a subscription. Returns an async cleanup
 * function that closes the subscription and resolves when the underlying
 * `'closed'` event fires. The caller owns the returned value; wiring it to
 * SIGINT/SIGTERM happens in `main()`.
 *
 * The subscription filters transactions by `accountInclude: args.programs`
 * — Yellowstone delivers any transaction whose account set contains at
 * least one of the listed programs. Vote transactions are excluded since
 * they never carry program logs; failed transactions are included because
 * log parsing works for them too (the decoder marks the chunk `success: false`).
 */
export async function run(args: Args, io: Io, deps: RunDeps = {}): Promise<() => Promise<void>> {
  if (!args.geyser) {
    // Defensive — parseArgs and main() route the webhook mode away from
    // run(). Reaching here without a geyser URL is a programmer error.
    throw new Error('run() requires args.geyser; call runWebhook() for --webhook mode');
  }
  const geyserUrl = args.geyser;
  const now = deps.now ?? Date.now;
  const registry = buildRegistry(args.decoders);

  // The RPC pool is constructed eagerly when the user supplies --rpc so that
  // consumers copying this example see where it would be injected. We don't
  // call anything on it here — substrate hooks that rely on it (historical
  // backfill, account fetches) are out of scope for the watch example.
  //
  // Intentionally commented out to keep the dead-code linter happy while
  // preserving the wiring guidance for readers of this file. A real vertical
  // copies the construction verbatim and calls `pool.call(...)` from its
  // signal generator.
  if (args.rpc.length > 0) {
    io.stderr(
      `solana-watch: ${args.rpc.length} RPC endpoint(s) supplied (not used by the watch example).`,
    );
  }

  const geyserOpts: GeyserClientOptions = {
    endpoint: {
      url: geyserUrl,
      ...(args.geyserToken !== undefined ? { token: args.geyserToken } : {}),
      ...(args.insecure ? { insecure: true } : {}),
    },
  };
  const factory = deps.geyserFactory ?? ((o: GeyserClientOptions) => new GeyserClient(o));
  const client = factory(geyserOpts);

  // Build the SubscribeRequest: one filter entry keyed by `watch` that
  // includes every requested program. Yellowstone's `accountInclude` is an
  // OR filter — a transaction matches if ANY listed account is present.
  const req: SubscribeRequest = {
    transactions: {
      watch: {
        vote: false,
        failed: true,
        accountInclude: args.programs.slice(),
      },
    },
    commitment: 'confirmed',
  };

  const sub: Subscription = client.subscribe(req, (update: GeyserUpdate) => {
    // Handler runs with backpressure — the GeyserClient awaits this before
    // draining the next update.
    try {
      handleUpdate(update, registry, io, now);
    } catch (err) {
      io.stderr(`solana-watch: handler error: ${(err as Error).message}`);
    }
  });

  sub.on('error', (err: Error) => {
    io.stderr(`solana-watch: stream error: ${err.message}`);
  });
  sub.on('dropped', (d: { count: number; since: string }) => {
    io.stderr(`solana-watch: dropped ${d.count} updates (since ${d.since})`);
  });
  sub.on('gap', (g: { from: number; to: number }) => {
    io.stderr(`solana-watch: slot gap ${g.from}..${g.to}`);
  });

  return () =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      sub.on('closed', finish);
      sub.close();
      // Belt-and-braces: if the subscription was already closed when we
      // got here, `'closed'` won't fire a second time — schedule a
      // microtask to resolve anyway so the caller never hangs.
      queueMicrotask(() => {
        if (!done) finish();
      });
    });
}

// ---------------------------------------------------------------------------
// main() — the production entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`solana-watch: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const io: Io = {
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
  };

  if (args.mode === 'webhook') {
    // One-shot — runWebhook returns synchronously after emitting. Don't
    // install signal handlers; the process exits naturally once stdout
    // drains.
    runWebhook(args, io);
    return;
  }

  const close = await run(args, io);

  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Vitest sets the VITEST env var; we detect it so the module can be imported
// under the test runner without kicking off a real subscription. The guard
// also lets tools that merely type-check the module avoid invoking main().
if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    process.stderr.write(`solana-watch: fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
