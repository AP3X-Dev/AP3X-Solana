import { EventEmitter } from 'node:events';
import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import type { EventDecoderRegistry } from '@ap3x/solana-events';
import { parseLogs } from '@ap3x/solana-events';
import type { SignalSource } from '../source.js';
import type { Signal } from '../signal.js';
import { signalId } from '../signal-id.js';

export interface HistoricalSignalSourceOpts {
  rpcPool: RpcPool;
  decoderRegistry: EventDecoderRegistry;
  programIds: PublicKey[];
  slotRange: { from: number; to: number };
  batchSize?: number;
  name?: string;
}

/**
 * A {@link SignalSource} that walks a slot range via `RpcPool.call('getBlocks')`
 * + `getBlock`, parses each transaction's logs, and emits signals for every
 * decoded event whose program ID matches the configured filter.
 *
 * Iteration is lazy and batchSize-bounded: `getBlocks` is called once per
 * batch of slots rather than for the entire range in one shot. This lets the
 * caller control back-pressure and avoids blowing the RPC response-size limit.
 *
 * This is the backfill counterpart to a live Geyser stream — both implement
 * {@link SignalSource} so consumers can swap them without code changes.
 */
export class HistoricalSignalSource extends EventEmitter implements SignalSource {
  readonly name: string;
  private aborted = false;
  private readonly opts: Required<Omit<HistoricalSignalSourceOpts, 'name'>>;

  constructor(opts: HistoricalSignalSourceOpts) {
    super();
    this.name = opts.name ?? 'historical';
    this.opts = {
      rpcPool: opts.rpcPool,
      decoderRegistry: opts.decoderRegistry,
      programIds: opts.programIds,
      slotRange: opts.slotRange,
      batchSize: opts.batchSize ?? 100,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.addEventListener('abort', () => { this.aborted = true; });
    const { from, to } = this.opts.slotRange;
    // Build a set of base58 program ID strings for O(1) membership checks.
    const programIdSet = new Set(this.opts.programIds.map((p) => p.toBase58()));

    try {
      for (let cursor = from; cursor <= to && !this.aborted; cursor += this.opts.batchSize) {
        const chunkTo = Math.min(cursor + this.opts.batchSize - 1, to);

        // `getBlocks` returns the list of confirmed slots in [cursor, chunkTo].
        const slots = (await this.opts.rpcPool.call('getBlocks', [cursor, chunkTo])) as number[];

        for (const slot of slots) {
          if (this.aborted) break;

          // Fetch full block with JSON-encoded transactions so we can read
          // logMessages without an additional `getTransaction` call per tx.
          const block = (await this.opts.rpcPool.call('getBlock', [
            slot,
            { maxSupportedTransactionVersion: 0, encoding: 'json', transactionDetails: 'full' },
          ])) as BlockResponse | null;

          if (!block?.transactions) continue;

          const blockTs = (block.blockTime ?? 0) * 1000;

          for (const tx of block.transactions) {
            const sig = tx.transaction?.signatures?.[0];
            if (!sig || !tx.meta?.logMessages) continue;

            // Parse the flat log array into a chunk tree, then decode every
            // recognized program invocation.
            const transactionLog = parseLogs(tx.meta.logMessages);
            const decoded = this.opts.decoderRegistry.decode(transactionLog);

            // Walk events in DFS order (as returned by the registry). We use
            // the array index as the logIndex for `signalId` determinism.
            decoded.events.forEach((ev, logIndex) => {
              if (ev.kind !== 'decoded') return;
              if (!programIdSet.has(ev.programId)) return;

              const programId = PublicKey.fromBase58(ev.programId);

              // Find the matching top-level chunk (or any chunk) for the raw field.
              // The registry walks DFS so we find the first chunk for this program.
              const rawChunk = findChunkByProgramId(transactionLog.chunks, ev.programId);

              const out: Signal = {
                signalId: signalId({ signature: sig, programId, kind: ev.kind, logIndex }),
                ts: blockTs,
                slot,
                signature: sig,
                programId,
                // Use the string 'decoded' as kind since DecodedEvent.kind === 'decoded'.
                // Consumers interested in the vertical-specific event kind should
                // inspect Signal.decoded directly.
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
          }
        }
      }
      this.emit('end');
    } catch (err) {
      this.emit('error', err);
    }
  }

  async stop(): Promise<void> {
    this.aborted = true;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * DFS search for the first {@link ProgramLogChunk} with the given programId
 * across a chunk forest. Returns `undefined` if not found.
 */
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

// ---------------------------------------------------------------------------
// RPC response shape (internal — not exported, avoids @solana/web3.js dep)
// ---------------------------------------------------------------------------

interface BlockTransaction {
  transaction?: {
    signatures?: string[];
  };
  meta?: {
    logMessages?: string[];
  };
}

interface BlockResponse {
  blockTime?: number | null;
  transactions?: BlockTransaction[];
}
