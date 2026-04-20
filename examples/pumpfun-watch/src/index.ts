/**
 * pumpfun-watch CLI entry point.
 *
 * Usage (fixture replay):
 *   node dist/index.js --source fixture [--fixture-path <path.jsonl.gz>] [--max-events <N>]
 *
 * Usage (historical backfill — live wiring TBD, see backlog B8/B10):
 *   node dist/index.js --source historical --rpc <url> --from <slot> --to <slot>
 *
 * Usage (live Geyser — live wiring TBD, see backlog B8/B10):
 *   node dist/index.js --source live --geyser <url>
 *
 * Only the fixture path is fully wired and tested in Task 17.
 * Historical and live paths are scaffolded with clear TODO comments pointing
 * at the backlog items that will wire them.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FixtureSignalSource,
  HistoricalSignalSource,
  GeyserSignalSource,
  SignalQueue,
} from '@ap3x/solana-signals';
import { EventDecoderRegistry } from '@ap3x/solana-events';
import { RpcPool } from '@ap3x/solana-connectivity';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
  bondingCurveDecoder,
  pumpSwapDecoder,
} from '@ap3x/pumpfun-events';
import { StrategyRuntime } from '@ap3x/solana-strategy';
import type { ExecutorLike, PortfolioLike, RpcPoolLike } from '@ap3x/solana-strategy';

import { WatcherStrategy } from './watcher-strategy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type SourceKind = 'fixture' | 'historical' | 'live';

interface ParsedArgs {
  source: SourceKind;
  fixturePath?: string;
  rpc?: string;
  geyser?: string;
  fromSlot?: number;
  toSlot?: number;
  maxEvents?: number;
}

const USAGE = `
Usage:
  pumpfun-watch --source fixture [--fixture-path <path.jsonl.gz>] [--max-events <N>]
  pumpfun-watch --source historical --rpc <url> --from <slot> --to <slot> [--max-events <N>]
  pumpfun-watch --source live --geyser <url> [--max-events <N>]

--source is required.
--fixture-path defaults to the bundled fixture when --source fixture is used.
Historical (--source historical) requires --rpc, --from, and --to.
Live (--source live) requires --geyser and runs until SIGINT.
`.trim();

/**
 * Extract the value for a CLI flag. Supports both space-separated
 * (`--flag value`) and equals-separated (`--flag=value`) forms.
 *
 * Returns `undefined` when the flag is absent. Throws when the flag is
 * present but has no value (e.g. `--flag` at end of argv).
 */
function takeFlag(argv: string[], name: string): string | undefined {
  const eq = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === `--${name}`) {
      if (i + 1 >= argv.length) {
        throw new Error(`--${name} requires a value.\n\n${USAGE}`);
      }
      return argv[i + 1];
    }
    if (arg.startsWith(eq)) {
      return arg.slice(eq.length);
    }
  }
  return undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const source = takeFlag(argv, 'source');
  if (source === undefined) {
    throw new Error(`--source is required.\n\n${USAGE}`);
  }
  if (source !== 'fixture' && source !== 'historical' && source !== 'live') {
    throw new Error(`--source must be one of: fixture, historical, live.\n\n${USAGE}`);
  }

  const fixturePath = takeFlag(argv, 'fixture-path');
  const rpc = takeFlag(argv, 'rpc');
  const geyser = takeFlag(argv, 'geyser');

  const fromRaw = takeFlag(argv, 'from');
  const toRaw = takeFlag(argv, 'to');
  const maxRaw = takeFlag(argv, 'max-events');

  const fromSlot = fromRaw !== undefined ? Number(fromRaw) : undefined;
  const toSlot = toRaw !== undefined ? Number(toRaw) : undefined;
  const maxEvents = maxRaw !== undefined ? Number(maxRaw) : undefined;

  if (source === 'historical') {
    if (rpc === undefined || fromSlot === undefined || toSlot === undefined) {
      throw new Error(
        `--source historical requires --rpc <url> --from <slot> --to <slot>.\n\n${USAGE}`,
      );
    }
  }
  if (source === 'live' && geyser === undefined) {
    throw new Error(`--source live requires --geyser <url>.\n\n${USAGE}`);
  }

  // exactOptionalPropertyTypes: only include optional fields when defined.
  return {
    source: source as SourceKind,
    ...(fixturePath !== undefined ? { fixturePath } : {}),
    ...(rpc !== undefined ? { rpc } : {}),
    ...(geyser !== undefined ? { geyser } : {}),
    ...(fromSlot !== undefined ? { fromSlot } : {}),
    ...(toSlot !== undefined ? { toSlot } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
  };
}

// ---------------------------------------------------------------------------
// Decoder registry — only needed for historical / live paths
// ---------------------------------------------------------------------------

function buildDecoderRegistry(): EventDecoderRegistry {
  const registry = new EventDecoderRegistry();
  registry.register(PUMPFUN_BONDING_CURVE_PROGRAM_ID, bondingCurveDecoder);
  registry.register(PUMPFUN_PUMPSWAP_PROGRAM_ID, pumpSwapDecoder);
  return registry;
}

// ---------------------------------------------------------------------------
// Source construction
// ---------------------------------------------------------------------------

/**
 * Resolve the bundled fixture path. The fixture lives alongside the compiled
 * `index.js` under `tests/fixtures/` — it's bundled with the package so
 * `--source fixture` with no `--fixture-path` always works regardless of cwd.
 *
 * At build time tsup outputs to `dist/`, so `__dirname` becomes
 * `<pkg>/dist/`. The fixture lives at `<pkg>/tests/fixtures/...`.
 */
function defaultFixturePath(): string {
  return path.resolve(__dirname, '..', 'tests', 'fixtures', 'signals-pumpfun-watch.jsonl.gz');
}

async function buildSource(
  args: ParsedArgs,
  registry: EventDecoderRegistry,
): Promise<FixtureSignalSource | HistoricalSignalSource | GeyserSignalSource> {
  switch (args.source) {
    case 'fixture': {
      const fixturePath = args.fixturePath ?? defaultFixturePath();
      return new FixtureSignalSource({ path: fixturePath });
    }

    case 'historical': {
      // TODO (B8/B10): full historical wiring. The RpcPool is built here but
      // the endpoint `name` field is constrained to a known union; use
      // 'custom' for user-supplied URLs.
      const rpcPool = new RpcPool({
        endpoints: [{ name: 'custom', url: args.rpc!, kind: 'http' }],
        strategy: 'roundRobinReads',
      });
      return new HistoricalSignalSource({
        rpcPool,
        decoderRegistry: registry,
        programIds: [PUMPFUN_BONDING_CURVE_PROGRAM_ID, PUMPFUN_PUMPSWAP_PROGRAM_ID],
        slotRange: { from: args.fromSlot!, to: args.toSlot! },
      });
    }

    case 'live': {
      // TODO (B8/B10): live Geyser wiring — gated on Helius Business credentials.
      // GeyserClient requires @grpc/grpc-js + proto loader; the constructor is
      // non-trivial. Scaffolded as a runtime error so the e2e fixture test still
      // passes without real gRPC infrastructure.
      throw new Error(
        `Live mode (--source live) is not yet wired.\n` +
        `This path is gated on Helius Business (backlog B8/B10).\n` +
        `Use --source fixture for the e2e fixture replay test instead.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Stub objects for the runtime (watcher never trades)
// ---------------------------------------------------------------------------

const stubExecutor: ExecutorLike = {
  submit: async () => { throw new Error('pumpfun-watch does not submit trades'); },
  on: () => {},
};

const stubPortfolio: PortfolioLike = {
  on: () => {},
  applyLandedTrade: async () => [],
  getPosition: async () => null,
  getAllPositions: async () => [],
  getRealizedPnl: async () => 0n,
  getUnrealizedPnl: async () => 0n,
};

const stubRpcPool: RpcPoolLike = {
  call: async () => null,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // For the fixture path the decoder registry is unused (FixtureSignalSource
  // emits already-decoded Signal objects). We build it lazily for
  // historical/live where it IS needed.
  const registry =
    args.source !== 'fixture' ? buildDecoderRegistry() : new EventDecoderRegistry();

  const source = await buildSource(args, registry);

  const signalQueue = new SignalQueue();
  source.on('signal', (sig) => { void signalQueue.push(sig); });

  const runtime = new StrategyRuntime({
    signalQueue,
    executor: stubExecutor,
    portfolio: stubPortfolio,
    rpcPool: stubRpcPool,
    resolveWallet: async () => { throw new Error('pumpfun-watch does not resolve wallets'); },
    // Suppress tick entirely — max safe integer ms delay will never fire during
    // a normal fixture replay or finite slot-range historical run.
    tickIntervalMs: 2_147_483_647,
  });

  await runtime.register(new WatcherStrategy(args.maxEvents));
  runtime.start();

  // Wait for the source to finish (meaningful for fixture + historical).
  // For the live path this would run until abort/SIGINT — that path is TBD (B8/B10).
  await new Promise<void>((resolve, reject) => {
    source.once('end', resolve);
    source.once('error', reject);
    source.start().catch(reject);
  });

  // Drain the queue so all in-flight signals are processed before exit.
  await signalQueue.drain();

  runtime.stop();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
