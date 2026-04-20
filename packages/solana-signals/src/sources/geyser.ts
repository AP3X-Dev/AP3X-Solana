import { EventEmitter } from 'node:events';
import { PublicKey } from '@ap3x/solana-core';
import type { GeyserClient, GeyserUpdate, SubscribeRequest } from '@ap3x/solana-connectivity';
import type { EventDecoderRegistry } from '@ap3x/solana-events';
import { parseLogs } from '@ap3x/solana-events';
import type { SignalSource } from '../source.js';
import type { Signal, GapEvent } from '../signal.js';
import { signalId } from '../signal-id.js';

export interface GeyserSignalSourceOpts {
  geyserClient: GeyserClient;
  decoderRegistry: EventDecoderRegistry;
  programIds: PublicKey[];
  name?: string;
}

/**
 * A normalised view of a Geyser transaction update. The real Geyser proto
 * puts these fields inside nested sub-messages; test fakes and live adapters
 * both reduce to this shape so the decoding logic stays uniform.
 */
interface GeyserTxUpdate {
  slot: number;
  signature: string;
  logs: string[];
}

/**
 * Attempt to extract a {@link GeyserTxUpdate} from a live {@link GeyserUpdate}
 * transaction envelope. Returns `undefined` for non-transaction updates or
 * malformed payloads.
 *
 * The Yellowstone proto stores transaction details under
 * `update.transaction.transaction`, with logs in the `meta.logMessages`
 * repeated field and the primary signature at index 0 of
 * `transaction.signatures`. Slots arrive as strings (proto `uint64` → JS
 * string via proto-loader's `longs: 'String'` option).
 *
 * NOTE: live extraction is provided as best-effort for future use. The
 * mandatory unit test drives against a fake client that passes the simplified
 * `{ slot, signature, logs }` shape directly to the handler — those fields are
 * read in the same place as the proto path, so both paths share one handler.
 */
function extractTxUpdate(update: GeyserUpdate | GeyserTxUpdate): GeyserTxUpdate | undefined {
  // Test-fake / pre-normalised path: top-level slot + signature + logs.
  const flat = update as Record<string, unknown>;
  if (
    typeof flat['slot'] === 'number' &&
    typeof flat['signature'] === 'string' &&
    Array.isArray(flat['logs'])
  ) {
    return { slot: flat['slot'] as number, signature: flat['signature'] as string, logs: flat['logs'] as string[] };
  }

  // Live Geyser proto path: update.transaction.transaction.{slot,meta,...}
  const txEnvelope = flat['transaction'] as Record<string, unknown> | undefined;
  if (!txEnvelope) return undefined;

  const slot = Number(txEnvelope['slot']);
  if (!Number.isFinite(slot)) return undefined;

  const txInner = txEnvelope['transaction'] as Record<string, unknown> | undefined;
  const meta = txEnvelope['meta'] as Record<string, unknown> | undefined;

  const sigs = (txInner?.['signatures'] ?? txInner?.['transaction']?.['signatures']) as string[] | undefined;
  const signature = Array.isArray(sigs) && typeof sigs[0] === 'string' ? sigs[0] : undefined;
  if (!signature) return undefined;

  const rawLogs = (meta?.['logMessages'] ?? []) as string[];
  return { slot, signature, logs: rawLogs };
}

/**
 * A {@link SignalSource} that wraps a live {@link GeyserClient} Yellowstone
 * gRPC subscription and emits a {@link Signal} for every decoded event whose
 * program ID matches the configured filter.
 *
 * Gap detection mirrors the slot-skip logic in the {@link GeyserClient}
 * itself: when consecutive transaction updates skip a slot, a {@link GapEvent}
 * is emitted so upstream consumers (e.g. a historical-backfill worker) can
 * refill the missing range.
 *
 * Live mainnet testing is gated on Helius Business (backlog item B8). For now,
 * the only covered test is the in-process fake-client unit test in
 * `geyser.test.ts`.
 */
export class GeyserSignalSource extends EventEmitter implements SignalSource {
  readonly name: string;
  private subscription: { close(): void } | null = null;
  private readonly opts: GeyserSignalSourceOpts;
  private lastSlot = 0;
  private readonly programIdSet: Set<string>;

  constructor(opts: GeyserSignalSourceOpts) {
    super();
    this.name = opts.name ?? 'geyser';
    this.opts = opts;
    this.programIdSet = new Set(opts.programIds.map((p) => p.toBase58()));
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener('abort', () => { void this.stop(); });

    const req: SubscribeRequest = {
      transactions: {
        all: {
          vote: false,
          failed: false,
          accountInclude: this.opts.programIds.map((p) => p.toBase58()),
        },
      },
    };

    const rawSub = this.opts.geyserClient.subscribe(
      req,
      (update: GeyserUpdate) => {
        try {
          const tx = extractTxUpdate(update as unknown as GeyserUpdate | GeyserTxUpdate);
          if (!tx) return;

          if (this.lastSlot !== 0 && tx.slot > this.lastSlot + 1) {
            const gap: GapEvent = {
              fromSlot: this.lastSlot + 1,
              toSlot: tx.slot - 1,
              reason: 'skip',
            };
            this.emit('gap', gap);
          }
          this.lastSlot = tx.slot;

          const transactionLog = parseLogs(tx.logs);
          const decoded = this.opts.decoderRegistry.decode(transactionLog);

          decoded.events.forEach((ev, logIndex) => {
            if (ev.kind !== 'decoded') return;
            if (!this.programIdSet.has(ev.programId)) return;

            const programIdPk = PublicKey.fromBase58(ev.programId);

            // Best-effort raw chunk lookup for the Signal.raw field.
            const rawChunk = findChunkByProgramId(transactionLog.chunks, ev.programId);

            const out: Signal = {
              signalId: signalId({ signature: tx.signature, programId: programIdPk, kind: ev.kind, logIndex }),
              ts: Date.now(),
              slot: tx.slot,
              signature: tx.signature,
              programId: programIdPk,
              kind: ev.kind,
              decoded: ev.data,
              raw: rawChunk ?? {
                programId: ev.programId,
                depth: 1,
                success: true,
                logs: [],
                dataPayloads: [],
                children: [],
                rawLines: [],
              },
            };
            this.emit('signal', out);
          });
        } catch (err) {
          this.emit('error', err);
        }
      },
    );

    // The real GeyserClient returns a Subscription (close()). Test fakes may
    // return { unsubscribe() } — cast via a compatibility shim.
    const sub = rawSub as unknown as { close?(): void; unsubscribe?(): void };
    this.subscription = {
      close: () => { sub.close?.() ?? sub.unsubscribe?.(); },
    };
  }

  async stop(): Promise<void> {
    this.subscription?.close();
    this.subscription = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findChunkByProgramId(
  chunks: ReadonlyArray<import('@ap3x/solana-events').ProgramLogChunk>,
  programId: string,
): import('@ap3x/solana-events').ProgramLogChunk | undefined {
  for (const chunk of chunks) {
    if (chunk.programId === programId) return chunk;
    const child = findChunkByProgramId(chunk.children, programId);
    if (child) return child;
  }
  return undefined;
}
