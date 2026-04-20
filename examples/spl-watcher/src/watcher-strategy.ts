import { Strategy } from '@ap3x/solana-strategy';
import type { StrategyContext, SignalFilter } from '@ap3x/solana-strategy';
import type { Signal } from '@ap3x/solana-signals';
import { SPL_TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import type { PublicKey } from '@ap3x/solana-core';

export interface WatcherDecoded {
  source?: PublicKey | string;
  /**
   * Destination wallet. Live-decoded signals carry a `PublicKey`; the fixture
   * source emits the base58 string directly (FixtureSignalSource does not
   * hydrate nested decoded fields). Both forms are accepted here.
   */
  dest?: PublicKey | string;
  /** Fixture uses number; live decode produces bigint; string is also accepted. */
  amount?: number | bigint | string;
}

export class WatcherStrategy extends Strategy {
  readonly name = 'spl-watcher';
  readonly filters: SignalFilter[] = [{ programId: SPL_TOKEN_PROGRAM_ID, kind: 'spl.transfer' }];

  constructor(
    private readonly watchedWallets: Set<string>,
    /** Injectable emitter for tests; defaults to console.log. */
    private readonly emit: (line: string) => void = (l) => console.log(l),
  ) {
    super();
  }

  async onSignal(signal: Signal, _ctx: StrategyContext): Promise<null> {
    const decoded = signal.decoded as WatcherDecoded;
    if (decoded.dest) {
      // Accept both PublicKey objects (live decode) and plain base58 strings (fixture source).
      const destStr =
        typeof decoded.dest === 'string' ? decoded.dest : decoded.dest.toBase58();
      if (this.watchedWallets.has(destStr)) {
        this.emit(
          JSON.stringify({
            wallet: destStr,
            sig: signal.signature,
            slot: signal.slot,
            amount:
              decoded.amount === undefined ? '?' : BigInt(decoded.amount as bigint).toString(),
          }),
        );
      }
    }
    return null;
  }
}
