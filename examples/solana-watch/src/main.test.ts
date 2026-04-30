/**
 * Tests for the `solana-watch` example.
 *
 * These drive the orchestration in-memory via a fake `GeyserClient` so no
 * network, gRPC, or proto-loader work happens. The fake mirrors the
 * real-GeyserClient surface that `run()` touches: `subscribe()` returns an
 * EventEmitter-shaped handle with a `close()` method.
 *
 * The harness exposes a `push()` helper for the test to feed synthetic
 * transaction updates into the handler that `run()` passed to `subscribe()`.
 * Between the fake client and the captured stdout/stderr arrays, every
 * behaviour asserted below is checked against the public JSON-line schema
 * without relying on implementation details of `GeyserClient`.
 */

import { EventEmitter } from 'node:events';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  parseArgs,
  buildRegistry,
  extractLogMessages,
  extractSlot,
  handleUpdate,
  run,
  type Args,
  type Io,
  type WatchLine,
} from './main';

import type {
  GeyserClient,
  GeyserClientOptions,
  GeyserUpdate,
  SubscribeRequest,
  Subscription,
} from '@ap3x/solana-connectivity';

// ---------------------------------------------------------------------------
// Fixture program IDs
// ---------------------------------------------------------------------------

const TOKEN_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const METAPLEX_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const UNKNOWN_ID = 'VoteKeoQRgPvXeMJX7fN4g3Y1QdBnV51eQJyPvTmWjN';

// ---------------------------------------------------------------------------
// Fake GeyserClient — records the subscribe call and exposes a push() hook
// ---------------------------------------------------------------------------

interface FakeSubscription extends Subscription {
  push: (u: GeyserUpdate) => void;
  pushError: (err: Error) => void;
  pushDropped: (count: number, since: string) => void;
  pushGap: (from: number, to: number) => void;
}

class FakeSubscriptionImpl extends EventEmitter implements FakeSubscription {
  #closed = false;
  readonly handler: (update: GeyserUpdate) => void | Promise<void>;
  closedCount = 0;

  constructor(handler: (update: GeyserUpdate) => void | Promise<void>) {
    super();
    this.handler = handler;
  }

  loadedCheckpoint(): null {
    return null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.closedCount += 1;
    queueMicrotask(() => this.emit('closed'));
  }

  async push(u: GeyserUpdate): Promise<void> {
    if (this.#closed) return;
    await this.handler(u);
  }

  pushError(err: Error): void {
    this.emit('error', err);
  }

  pushDropped(count: number, since: string): void {
    this.emit('dropped', { count, since });
  }

  pushGap(from: number, to: number): void {
    this.emit('gap', { from, to });
  }
}

class FakeGeyserClient {
  lastOptions!: GeyserClientOptions;
  lastRequest!: SubscribeRequest;
  currentSubscription: FakeSubscriptionImpl | null = null;

  constructor(opts: GeyserClientOptions) {
    this.lastOptions = opts;
  }

  subscribe(
    req: SubscribeRequest,
    handler: (update: GeyserUpdate) => void | Promise<void>,
  ): Subscription {
    this.lastRequest = req;
    this.currentSubscription = new FakeSubscriptionImpl(handler);
    return this.currentSubscription;
  }
}

function mkFakeFactory(): {
  factory: (opts: GeyserClientOptions) => GeyserClient;
  last: () => FakeGeyserClient;
} {
  let lastClient: FakeGeyserClient | null = null;
  return {
    factory: (opts) => {
      lastClient = new FakeGeyserClient(opts);
      return lastClient as unknown as GeyserClient;
    },
    last: () => {
      if (!lastClient) throw new Error('factory was never called');
      return lastClient;
    },
  };
}

function mkIo(): { io: Io; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    },
    stdout,
    stderr,
  };
}

/** Synthesize a Geyser transaction update with the given logs. */
function txUpdate(slot: number, logs: string[]): GeyserUpdate {
  // The fake shape mirrors Yellowstone's keepCase:false camelCase output:
  // update.transaction.transaction.meta.logMessages.
  return {
    transaction: {
      slot,
      transaction: {
        meta: {
          logMessages: logs,
        },
      },
    },
  } as unknown as GeyserUpdate;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses a minimal valid invocation', () => {
    const args = parseArgs(['--program', TOKEN_ID, '--geyser', 'grpc://y:443']);
    expect(args.programs).toEqual([TOKEN_ID]);
    expect(args.geyser).toBe('grpc://y:443');
    // Default decoder set when none specified.
    expect(args.decoders).toEqual(['spl', 'spl-2022', 'metaplex']);
    expect(args.rpc).toEqual([]);
    expect(args.insecure).toBe(false);
  });

  it('accepts repeated --program and --rpc', () => {
    const args = parseArgs([
      '--program', TOKEN_ID,
      '--program', METAPLEX_ID,
      '--rpc', 'https://r1',
      '--rpc', 'https://r2',
      '--geyser', 'grpc://y:443',
    ]);
    expect(args.programs).toEqual([TOKEN_ID, METAPLEX_ID]);
    expect(args.rpc).toEqual(['https://r1', 'https://r2']);
  });

  it('accepts --flag=value form', () => {
    const args = parseArgs([
      `--program=${TOKEN_ID}`,
      '--geyser=grpc://y:443',
      '--decoder=spl',
    ]);
    expect(args.programs).toEqual([TOKEN_ID]);
    expect(args.geyser).toBe('grpc://y:443');
    expect(args.decoders).toEqual(['spl']);
  });

  it('parses --geyser-token and --insecure', () => {
    const args = parseArgs([
      '--program', TOKEN_ID,
      '--geyser', 'grpc://y:443',
      '--geyser-token', 'secret',
      '--insecure',
    ]);
    expect(args.geyserToken).toBe('secret');
    expect(args.insecure).toBe(true);
  });

  it('throws when no --program is supplied', () => {
    expect(() => parseArgs(['--geyser', 'g'])).toThrow(/program/);
  });

  it('throws when --geyser is missing', () => {
    expect(() => parseArgs(['--program', TOKEN_ID])).toThrow(/geyser/);
  });

  it('throws when --decoder is unknown', () => {
    expect(() =>
      parseArgs([
        '--program', TOKEN_ID,
        '--geyser', 'g',
        '--decoder', 'does-not-exist',
      ]),
    ).toThrow(/unknown --decoder/);
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--weird'])).toThrow(/unknown flag/);
  });

  it('throws when a flag is missing its value', () => {
    expect(() => parseArgs(['--program'])).toThrow(/requires a value/);
  });

  it('throws when a flag is followed by another flag instead of a value', () => {
    expect(() => parseArgs(['--program', '--geyser'])).toThrow(/requires a value/);
  });

  it('rejects positional arguments', () => {
    expect(() => parseArgs(['extra', '--geyser', 'g'])).toThrow(/positional/);
  });
});

// ---------------------------------------------------------------------------
// buildRegistry
// ---------------------------------------------------------------------------

describe('buildRegistry', () => {
  it('registers only the requested decoders', () => {
    const r = buildRegistry(['spl']);
    expect(r.has(TOKEN_ID)).toBe(true);
    expect(r.has(TOKEN_2022_ID)).toBe(false);
    expect(r.has(METAPLEX_ID)).toBe(false);
  });

  it('registers all three when requested', () => {
    const r = buildRegistry(['spl', 'spl-2022', 'metaplex']);
    expect(r.has(TOKEN_ID)).toBe(true);
    expect(r.has(TOKEN_2022_ID)).toBe(true);
    expect(r.has(METAPLEX_ID)).toBe(true);
  });

  it('throws on an unknown name (defense in depth past parseArgs)', () => {
    expect(() => buildRegistry(['nope'])).toThrow(/unknown decoder/);
  });
});

// ---------------------------------------------------------------------------
// extractLogMessages / extractSlot
// ---------------------------------------------------------------------------

describe('extractLogMessages', () => {
  it('pulls the logs out of a well-formed transaction update', () => {
    const u = txUpdate(100, ['hello', 'world']);
    expect(extractLogMessages(u)).toEqual(['hello', 'world']);
  });

  it('returns null when the update has no transaction envelope', () => {
    expect(extractLogMessages({})).toBeNull();
    expect(extractLogMessages({ slot: { slot: 1 } })).toBeNull();
  });

  it('returns null when meta.logMessages is absent', () => {
    const u = {
      transaction: { slot: 1, transaction: { meta: {} } },
    } as unknown as GeyserUpdate;
    expect(extractLogMessages(u)).toBeNull();
  });

  it('drops non-string entries from logMessages', () => {
    const u = {
      transaction: {
        slot: 1,
        transaction: { meta: { logMessages: ['a', 42, 'b', null, 'c'] } },
      },
    } as unknown as GeyserUpdate;
    expect(extractLogMessages(u)).toEqual(['a', 'b', 'c']);
  });
});

describe('extractSlot', () => {
  it('reads the slot off the transaction envelope', () => {
    expect(extractSlot(txUpdate(1234, ['x']))).toBe(1234);
  });

  it('coerces string slot to number', () => {
    const u = {
      transaction: { slot: '555', transaction: { meta: { logMessages: [] } } },
    } as unknown as GeyserUpdate;
    expect(extractSlot(u)).toBe(555);
  });

  it('returns 0 when no slot is available', () => {
    expect(extractSlot({})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleUpdate — full decode path
// ---------------------------------------------------------------------------

describe('handleUpdate', () => {
  let now: () => number;
  let tick: number;

  beforeEach(() => {
    tick = 1000;
    now = () => {
      const t = tick;
      // Advance by 1ms per call so latencyMs is deterministic (>= 1).
      tick += 1;
      return t;
    };
  });

  it('emits JSON lines for decoded SPL events', () => {
    const { io, stdout } = mkIo();
    const registry = buildRegistry(['spl']);
    const logs = [
      `Program ${TOKEN_ID} invoke [1]`,
      'Program log: Instruction: Transfer',
      `Program ${TOKEN_ID} success`,
    ];
    handleUpdate(txUpdate(42, logs), registry, io, now);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0] as string) as WatchLine;
    expect(parsed.slot).toBe(42);
    expect(parsed.programId).toBe(TOKEN_ID);
    expect(parsed.kind).toBe('spl-token-event');
    expect(parsed.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('emits kind:"unknown" for programs without a decoder', () => {
    const { io, stdout } = mkIo();
    const registry = buildRegistry(['spl']);
    const logs = [
      `Program ${UNKNOWN_ID} invoke [1]`,
      'Program log: noop',
      `Program ${UNKNOWN_ID} success`,
    ];
    handleUpdate(txUpdate(7, logs), registry, io, now);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0] as string) as WatchLine;
    expect(parsed.kind).toBe('unknown');
    expect(parsed.programId).toBe(UNKNOWN_ID);
  });

  it('decodes SPL Token-2022 events via the spl-2022 decoder', () => {
    const { io, stdout } = mkIo();
    const registry = buildRegistry(['spl-2022']);
    const logs = [
      `Program ${TOKEN_2022_ID} invoke [1]`,
      'Program log: Instruction: Transfer',
      `Program ${TOKEN_2022_ID} success`,
    ];
    handleUpdate(txUpdate(11, logs), registry, io, now);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0] as string) as WatchLine;
    expect(parsed.kind).toBe('spl-token-2022-event');
    expect(parsed.programId).toBe(TOKEN_2022_ID);
  });

  it('emits one line per decoded chunk including CPI children', () => {
    const { io, stdout } = mkIo();
    const registry = buildRegistry(['spl', 'metaplex']);
    const logs = [
      `Program ${METAPLEX_ID} invoke [1]`,
      'Program log: mint begin',
      `Program ${TOKEN_ID} invoke [2]`,
      'Program log: Instruction: MintTo',
      `Program ${TOKEN_ID} success`,
      `Program ${METAPLEX_ID} success`,
    ];
    handleUpdate(txUpdate(200, logs), registry, io, now);
    expect(stdout).toHaveLength(2);
    const [outer, inner] = stdout.map((l) => JSON.parse(l) as WatchLine);
    expect(outer!.programId).toBe(METAPLEX_ID);
    expect(outer!.kind).toBe('metaplex-metadata-event');
    expect(inner!.programId).toBe(TOKEN_ID);
    expect(inner!.kind).toBe('spl-token-event');
  });

  it('does nothing when the update has no logs', () => {
    const { io, stdout } = mkIo();
    const registry = buildRegistry(['spl']);
    handleUpdate({} as GeyserUpdate, registry, io, now);
    expect(stdout).toHaveLength(0);
  });

  it('measures latency against the injected clock', () => {
    const { io, stdout } = mkIo();
    const registry = buildRegistry(['spl']);
    let t = 0;
    const stepClock = (): number => {
      // Step by 5ms every call; first call is 0, second is 5, etc.
      const v = t;
      t += 5;
      return v;
    };
    const logs = [
      `Program ${TOKEN_ID} invoke [1]`,
      `Program ${TOKEN_ID} success`,
    ];
    handleUpdate(txUpdate(1, logs), registry, io, stepClock);
    const parsed = JSON.parse(stdout[0] as string) as WatchLine;
    // startedAt=0, later=5 → latencyMs=5.
    expect(parsed.latencyMs).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// run() — end-to-end with fake GeyserClient
// ---------------------------------------------------------------------------

describe('run', () => {
  it('constructs a GeyserClient with the supplied endpoint + token', async () => {
    const { io } = mkIo();
    const { factory, last } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID],
      rpc: [],
      geyser: 'grpc://h:443',
      geyserToken: 'secret-token',
      decoders: ['spl'],
      insecure: true,
    };
    const close = await run(args, io, { geyserFactory: factory });
    const client = last();
    expect(client.lastOptions.endpoint.url).toBe('grpc://h:443');
    expect(client.lastOptions.endpoint.token).toBe('secret-token');
    expect(client.lastOptions.endpoint.insecure).toBe(true);
    await close();
  });

  it('subscribes to each --program via accountInclude', async () => {
    const { io } = mkIo();
    const { factory, last } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID, METAPLEX_ID],
      rpc: [],
      geyser: 'grpc://h:443',
      decoders: ['spl', 'metaplex'],
    };
    const close = await run(args, io, { geyserFactory: factory });
    const client = last();
    expect(client.lastRequest.transactions).toEqual({
      watch: {
        vote: false,
        failed: true,
        accountInclude: [TOKEN_ID, METAPLEX_ID],
      },
    });
    expect(client.lastRequest.commitment).toBe('confirmed');
    await close();
  });

  it('emits JSON lines on stdout for each decoded event', async () => {
    const { io, stdout } = mkIo();
    const { factory, last } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID],
      rpc: [],
      geyser: 'grpc://h:443',
      decoders: ['spl'],
    };
    const close = await run(args, io, {
      geyserFactory: factory,
      now: (() => {
        let t = 0;
        return () => {
          const v = t;
          t += 2;
          return v;
        };
      })(),
    });
    const sub = last().currentSubscription!;
    const logs = [
      `Program ${TOKEN_ID} invoke [1]`,
      'Program log: Instruction: Transfer',
      `Program ${TOKEN_ID} success`,
    ];
    await sub.push(txUpdate(5, logs));
    await sub.push(txUpdate(6, logs));
    expect(stdout).toHaveLength(2);
    const first = JSON.parse(stdout[0] as string) as WatchLine;
    expect(first).toMatchObject({
      slot: 5,
      programId: TOKEN_ID,
      kind: 'spl-token-event',
    });
    await close();
  });

  it('warns on stderr when RPC endpoints are supplied', async () => {
    const { io, stderr } = mkIo();
    const { factory } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID],
      rpc: ['https://rpc.example'],
      geyser: 'grpc://h:443',
      decoders: ['spl'],
    };
    const close = await run(args, io, { geyserFactory: factory });
    expect(stderr.some((l) => /RPC endpoint/.test(l))).toBe(true);
    await close();
  });

  it('emits a stderr line on stream error', async () => {
    const { io, stderr } = mkIo();
    const { factory, last } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID],
      rpc: [],
      geyser: 'grpc://h:443',
      decoders: ['spl'],
    };
    const close = await run(args, io, { geyserFactory: factory });
    last().currentSubscription!.pushError(new Error('boom'));
    expect(stderr.some((l) => /stream error: boom/.test(l))).toBe(true);
    await close();
  });

  it('emits a stderr line on dropped events', async () => {
    const { io, stderr } = mkIo();
    const { factory, last } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID],
      rpc: [],
      geyser: 'grpc://h:443',
      decoders: ['spl'],
    };
    const close = await run(args, io, { geyserFactory: factory });
    last().currentSubscription!.pushDropped(7, '2026-01-01T00:00:00.000Z');
    expect(stderr.some((l) => /dropped 7 updates/.test(l))).toBe(true);
    await close();
  });

  it('emits a stderr line on slot gap', async () => {
    const { io, stderr } = mkIo();
    const { factory, last } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID],
      rpc: [],
      geyser: 'grpc://h:443',
      decoders: ['spl'],
    };
    const close = await run(args, io, { geyserFactory: factory });
    last().currentSubscription!.pushGap(100, 110);
    expect(stderr.some((l) => /slot gap 100\.\.110/.test(l))).toBe(true);
    await close();
  });

  it('handler catches thrown errors and writes them to stderr', async () => {
    const { io, stderr } = mkIo();
    const { factory, last } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID],
      rpc: [],
      geyser: 'grpc://h:443',
      decoders: ['spl'],
    };
    const close = await run(args, io, {
      geyserFactory: factory,
      // `now` that throws forces `handleUpdate` to fail.
      now: () => {
        throw new Error('clock broken');
      },
    });
    const sub = last().currentSubscription!;
    await sub.push(
      txUpdate(1, [
        `Program ${TOKEN_ID} invoke [1]`,
        `Program ${TOKEN_ID} success`,
      ]),
    );
    expect(stderr.some((l) => /handler error: clock broken/.test(l))).toBe(true);
    await close();
  });

  it('close() resolves after the subscription emits closed', async () => {
    const { io } = mkIo();
    const { factory, last } = mkFakeFactory();
    const args: Args = {
      mode: 'geyser',
      programs: [TOKEN_ID],
      rpc: [],
      geyser: 'grpc://h:443',
      decoders: ['spl'],
    };
    const close = await run(args, io, { geyserFactory: factory });
    await close();
    expect(last().currentSubscription!.closedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Webhook mode
// ---------------------------------------------------------------------------

describe('parseArgs — webhook mode', () => {
  it('--webhook sets mode and skips the geyser/program requirements', () => {
    const args = parseArgs(['--webhook', './tests/fixtures/helius/swap_buy.json']);
    expect(args.mode).toBe('webhook');
    expect(args.webhook).toBe('./tests/fixtures/helius/swap_buy.json');
    expect(args.programs).toEqual([]);
    expect(args.geyser).toBeUndefined();
  });

  it('rejects --webhook combined with --geyser', () => {
    expect(() =>
      parseArgs(['--webhook', 'f.json', '--geyser', 'grpc://h:443']),
    ).toThrow(/cannot be combined/);
  });

  it('rejects --webhook combined with --program', () => {
    expect(() =>
      parseArgs(['--webhook', 'f.json', '--program', TOKEN_ID]),
    ).toThrow(/cannot be combined/);
  });
});

describe('runWebhook', () => {
  // The example imports normalizeHeliusTx from @ap3x/solana-webhooks; the
  // captured fixtures live under packages/solana-webhooks/tests/fixtures/.
  // Resolve from this file's directory so the test is cwd-independent and
  // works on both POSIX and Windows (fileURLToPath strips the leading slash
  // that Windows file URLs carry before the drive letter).
  const HERE = dirname(fileURLToPath(import.meta.url));
  const PKG_FIXTURES = pathResolve(HERE, '..', '..', '..', 'packages', 'solana-webhooks', 'tests', 'fixtures');
  const FIXTURES = join(PKG_FIXTURES, 'helius');

  it('emits a helius-swap line for a single-tx SWAP fixture', async () => {
    const { io, stdout: lines, stderr: errLines } = mkIo();
    const { runWebhook } = await import('./main');
    const close = runWebhook(
      {
        mode: 'webhook',
        programs: [],
        rpc: [],
        decoders: [],
        webhook: `${FIXTURES}/swap_buy.json`,
      },
      io,
      { now: () => 0 },
    );
    await close();
    expect(errLines).toEqual([]);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as WatchLine;
    expect(parsed.kind).toBe('helius-swap');
    expect(parsed.programId).toBe('11111111111111111111111111111111'); // UNKNOWN — source field absent
    expect(parsed.latencyMs).toBe(0);
  });

  it('emits one line per tx for an array-shape fixture', async () => {
    const { io, stdout: lines, stderr: errLines } = mkIo();
    const { runWebhook } = await import('./main');
    const close = runWebhook(
      {
        mode: 'webhook',
        programs: [],
        rpc: [],
        decoders: [],
        // helius_webhook_batch.json is the live wire shape (array of tx).
        webhook: join(PKG_FIXTURES, 'helius_webhook_batch.json'),
      },
      io,
      { now: () => 0 },
    );
    await close();
    expect(errLines).toEqual([]);
    // The batch fixture carries 2+ enhanced txs.
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const raw of lines) {
      const parsed = JSON.parse(raw) as WatchLine;
      expect(typeof parsed.kind).toBe('string');
      expect(typeof parsed.programId).toBe('string');
    }
  });

  it('reports a missing fixture via stderr without throwing', async () => {
    const { io, stdout: lines, stderr: errLines } = mkIo();
    const { runWebhook } = await import('./main');
    const close = runWebhook(
      {
        mode: 'webhook',
        programs: [],
        rpc: [],
        decoders: [],
        webhook: '/path/that/does/not/exist.json',
      },
      io,
    );
    await close();
    expect(lines).toEqual([]);
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toMatch(/cannot read --webhook fixture/);
  });
});
