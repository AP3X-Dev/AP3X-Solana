import { Strategy } from '@ap3x/solana-strategy';
import type { StrategyContext, SignalFilter } from '@ap3x/solana-strategy';
import type { Signal } from '@ap3x/solana-signals';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';

/**
 * Observer-only strategy: receives every signal whose `programId` matches one
 * of the two pump.fun programs (bonding curve + PumpSwap AMM), prints the
 * typed event to stdout as a JSON line, and returns `null` — never trades.
 *
 * We deliberately filter on `programId` only (not `kind`) so that every
 * `pumpfun.*` variant registered by `@ap3x/pumpfun-events` decoders flows
 * through a single strategy instance. Unknown variants surface as
 * `UnknownEventDecode` records via the events framework and still reach
 * `onSignal`; they're printed alongside typed events so they're visible
 * rather than silently dropped.
 */
export class WatcherStrategy extends Strategy {
  readonly name = 'pumpfun-watch';
  readonly filters: SignalFilter[] = [
    { programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID },
    { programId: PUMPFUN_PUMPSWAP_PROGRAM_ID },
  ];

  constructor(
    /** Optional cap on emissions; when reached, subsequent signals are skipped. */
    private readonly maxEvents: number | undefined,
    /** Injectable emitter for tests; defaults to console.log. */
    private readonly emit: (line: string) => void = (l) => console.log(l),
  ) {
    super();
  }

  private count = 0;

  override async onSignal(signal: Signal, _ctx: StrategyContext): Promise<null> {
    if (this.maxEvents !== undefined && this.count >= this.maxEvents) {
      return null;
    }
    this.count += 1;

    // Normalise programId → base58 string for JSON output. Signal.programId is
    // a PublicKey (FixtureSignalSource hydrates it on load).
    const programId = signal.programId.toBase58();

    // Serialise the decoded payload, coercing bigints to strings so JSON
    // doesn't blow up. Also project PublicKey instances to base58.
    const decoded = serialise(signal.decoded);

    this.emit(
      JSON.stringify({
        signalId: signal.signalId,
        ts: signal.ts,
        slot: signal.slot,
        signature: signal.signature,
        programId,
        kind: signal.kind,
        decoded,
      }),
    );
    return null;
  }
}

/**
 * Recursively project a decoded event into JSON-safe primitives:
 *   - bigint → decimal string
 *   - PublicKey (duck-typed via `toBase58`) → base58 string
 *   - arrays/objects → deep mapped
 *   - everything else → passthrough
 */
function serialise(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    // Duck-type PublicKey: both the fixture source (passes through strings)
    // and the live decode path (PublicKey instance from @ap3x/solana-core)
    // should render identically in the JSON output.
    const anyVal = value as { toBase58?: () => string };
    if (typeof anyVal.toBase58 === 'function') return anyVal.toBase58();
    if (Array.isArray(value)) return value.map(serialise);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialise(v);
    }
    return out;
  }
  return value;
}
