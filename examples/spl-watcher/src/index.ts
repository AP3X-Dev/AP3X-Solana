/**
 * spl-watcher CLI entry point.
 *
 * Usage (fixture replay):
 *   node dist/index.js --fixture <path.jsonl.gz> --wallet <base58> [--wallet <base58> ...]
 *
 * Usage (historical backfill — live wiring TBD, see backlog B8/B10):
 *   node dist/index.js --rpc <url> --from <slot> --to <slot> --wallet <base58>
 *
 * Usage (live Geyser — live wiring TBD, see backlog B8/B10):
 *   node dist/index.js --geyser <url> --wallet <base58>
 *
 * Only the fixture path is fully wired and tested in Phase E (T47).
 * Historical and Geyser paths are scaffolded with clear TODO comments.
 */

import { FixtureSignalSource, HistoricalSignalSource, GeyserSignalSource, SignalQueue } from '@ap3x/solana-signals';
import { EventDecoderRegistry } from '@ap3x/solana-events';
import { SPL_TOKEN_PROGRAM_ID, parseTransferLog } from '@ap3x/solana-spl';
import { PublicKey } from '@ap3x/solana-core';
import { RpcPool } from '@ap3x/solana-connectivity';
import { StrategyRuntime } from '@ap3x/solana-strategy';
import type { ExecutorLike, PortfolioLike, RpcPoolLike } from '@ap3x/solana-strategy';
import { WatcherStrategy } from './watcher-strategy.js';
import { parseWalletFlags } from './wallets.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  source: 'fixture' | 'historical' | 'geyser';
  fixture?: string;    // path to .jsonl.gz
  rpc?: string;        // JSON-RPC endpoint URL (historical)
  geyser?: string;     // Geyser gRPC endpoint URL
  fromSlot?: number;
  toSlot?: number;
  wallets: Set<string>;
}

const USAGE = `
Usage:
  spl-watcher --fixture <path.jsonl.gz> --wallet <base58> [--wallet ...]
  spl-watcher --rpc <url> --from <slot> --to <slot> --wallet <base58> [--wallet ...]
  spl-watcher --geyser <url> --wallet <base58> [--wallet ...]

Exactly one of --fixture / --rpc / --geyser is required.
Historical (--rpc) requires --from and --to slot bounds.
Geyser (--geyser) runs until SIGINT.
At least one --wallet is recommended (program emits nothing otherwise).
`.trim();

function parseArgs(argv: string[]): ParsedArgs {
  let fixture: string | undefined;
  let rpc: string | undefined;
  let geyser: string | undefined;
  let fromSlot: number | undefined;
  let toSlot: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Skip --wallet/--wallet=... tokens; their values are handled by parseWalletFlags.
    if (arg === '--wallet' || arg.startsWith('--wallet=')) continue;

    if (arg === '--fixture' && i + 1 < argv.length) { fixture = argv[++i]; continue; }
    if (arg.startsWith('--fixture=')) { fixture = arg.slice('--fixture='.length); continue; }

    if (arg === '--rpc' && i + 1 < argv.length) { rpc = argv[++i]; continue; }
    if (arg.startsWith('--rpc=')) { rpc = arg.slice('--rpc='.length); continue; }

    if (arg === '--geyser' && i + 1 < argv.length) { geyser = argv[++i]; continue; }
    if (arg.startsWith('--geyser=')) { geyser = arg.slice('--geyser='.length); continue; }

    if (arg === '--from' && i + 1 < argv.length) { fromSlot = Number(argv[++i]); continue; }
    if (arg.startsWith('--from=')) { fromSlot = Number(arg.slice('--from='.length)); continue; }

    if (arg === '--to' && i + 1 < argv.length) { toSlot = Number(argv[++i]); continue; }
    if (arg.startsWith('--to=')) { toSlot = Number(arg.slice('--to='.length)); continue; }
    // Unknown flags are silently ignored — forward-compatible with future flags.
  }

  // Exactly one source flag required.
  const sourceFlagsSet = [fixture, rpc, geyser].filter(Boolean);
  if (sourceFlagsSet.length === 0) {
    throw new Error(`No source flag provided.\n\n${USAGE}`);
  }
  if (sourceFlagsSet.length > 1) {
    throw new Error(`Conflicting source flags — provide exactly one of --fixture / --rpc / --geyser.\n\n${USAGE}`);
  }

  // Historical needs slot bounds.
  if (rpc !== undefined && (fromSlot === undefined || toSlot === undefined)) {
    throw new Error(`--rpc requires --from <slot> and --to <slot>.\n\n${USAGE}`);
  }

  const source: ParsedArgs['source'] =
    fixture !== undefined ? 'fixture' :
    rpc !== undefined     ? 'historical' :
                            'geyser';

  const wallets = parseWalletFlags(argv);

  // exactOptionalPropertyTypes: only include optional fields when defined so
  // we don't assign `undefined` to fields that expect absence.
  return {
    source,
    wallets,
    ...(fixture !== undefined ? { fixture } : {}),
    ...(rpc !== undefined ? { rpc } : {}),
    ...(geyser !== undefined ? { geyser } : {}),
    ...(fromSlot !== undefined ? { fromSlot } : {}),
    ...(toSlot !== undefined ? { toSlot } : {}),
  };
}

// ---------------------------------------------------------------------------
// Decoder registry — only needed for historical / geyser paths
// ---------------------------------------------------------------------------

function buildDecoderRegistry(): EventDecoderRegistry {
  const registry = new EventDecoderRegistry();

  // The SPL transfer decoder adapts between the events-layer ProgramLogChunk
  // (programId: string, children: ProgramLogChunk[], no accounts/inner) and the
  // spl-layer ProgramLogChunk (programId: PublicKey, inner: ..., accounts: []).
  // parseTransferLog only reads chunk.programId and chunk.logs, so the
  // structural bridge is minimal.
  registry.register(SPL_TOKEN_PROGRAM_ID, {
    programId: SPL_TOKEN_PROGRAM_ID,
    decode(chunk) {
      // Bridge: events-layer chunk has programId as string; spl layer expects PublicKey.
      const bridged = {
        programId: PublicKey.fromBase58(chunk.programId),
        accounts: [] as PublicKey[],
        logs: chunk.logs,
        inner: [],
      };
      const decoded = parseTransferLog(bridged);
      if (decoded !== null) {
        return { kind: 'spl.transfer', decoded, programId: SPL_TOKEN_PROGRAM_ID, raw: chunk, logIndex: 0 } as unknown as typeof decoded;
      }
      return {
        kind: 'unknown' as const,
        programId: chunk.programId,
        reason: 'not a transfer',
        rawLines: chunk.rawLines,
      };
    },
  });

  return registry;
}

// ---------------------------------------------------------------------------
// Source construction
// ---------------------------------------------------------------------------

async function buildSource(
  args: ParsedArgs,
  registry: EventDecoderRegistry,
): Promise<FixtureSignalSource | HistoricalSignalSource | GeyserSignalSource> {
  switch (args.source) {
    case 'fixture': {
      return new FixtureSignalSource({ path: args.fixture! });
    }

    case 'historical': {
      // TODO (B8/B10): full historical wiring. The RpcPool is built here but
      // the endpoint `name` field is constrained to a known union; use 'custom'
      // for user-supplied URLs.
      const rpcPool = new RpcPool({
        endpoints: [{ name: 'custom', url: args.rpc!, kind: 'http' }],
        strategy: 'roundRobinReads',
      });
      return new HistoricalSignalSource({
        rpcPool,
        decoderRegistry: registry,
        programIds: [SPL_TOKEN_PROGRAM_ID],
        slotRange: { from: args.fromSlot!, to: args.toSlot! },
      });
    }

    case 'geyser': {
      // TODO (B8/B10): live Geyser wiring — gated on Helius Business credentials.
      // GeyserClient requires @grpc/grpc-js + proto loader; the constructor is
      // non-trivial. Scaffolded as a runtime error so the e2e fixture test still
      // passes without real gRPC infrastructure.
      throw new Error(
        `Geyser live mode is not yet wired in Phase E.\n` +
        `This path is gated on Helius Business (backlog B8/B10).\n` +
        `Use --fixture for the e2e fixture replay test instead.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Stub objects for the runtime (watcher never trades)
// ---------------------------------------------------------------------------

const stubExecutor: ExecutorLike = {
  submit: async () => { throw new Error('spl-watcher does not submit trades'); },
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
  // historical/geyser where it IS needed.
  const registry = args.source !== 'fixture' ? buildDecoderRegistry() : new EventDecoderRegistry();

  const source = await buildSource(args, registry);

  const signalQueue = new SignalQueue();
  source.on('signal', (sig) => { void signalQueue.push(sig); });

  const runtime = new StrategyRuntime({
    signalQueue,
    executor: stubExecutor,
    portfolio: stubPortfolio,
    rpcPool: stubRpcPool,
    resolveWallet: async () => { throw new Error('spl-watcher does not resolve wallets'); },
    // Suppress tick entirely — max safe integer ms delay will never fire during
    // a normal fixture replay or finite slot-range historical run.
    tickIntervalMs: 2_147_483_647,
  });

  await runtime.register(new WatcherStrategy(args.wallets));
  runtime.start();

  // Wait for the source to finish (meaningful for fixture + historical).
  // For geyser this would run until abort/SIGINT — that path is TBD (B8/B10).
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
