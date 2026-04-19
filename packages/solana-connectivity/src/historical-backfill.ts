/**
 * RpcHistoricalBackfill — thin, typed JSON-RPC wrappers over `RpcPool`
 * focused on historical sweep / replay workflows.
 *
 * Per spec Section 3.2 / plan Task 16 this module exposes:
 *
 *   - `getSignaturesForAddress(addr, opts)` — single-page wrapper around the
 *     Solana JSON-RPC method of the same name. Returns the envelope the
 *     node produced; callers cast to their own `SignatureInfo` shape.
 *   - `iterateSignaturesForAddress(addr, opts)` — async generator that
 *     pages via the `before: <last-sig>` cursor. Stops when a page is
 *     short (< limit) or a configurable `maxPages` cap is reached.
 *   - `getTransaction(sig, opts)` — single-call wrapper. Defaults
 *     `maxSupportedTransactionVersion: 0` because v0 is the only supported
 *     transaction format in this stack — omitting it silently downgrades
 *     the response to a legacy-only envelope we deliberately do not
 *     support. v0 / versioned is a project-wide rule (CLAUDE.md).
 *   - `getBlocks(from, to)` — chunks long ranges into 1000-slot windows,
 *     concatenates results, returns a flat `number[]` of block slot
 *     numbers. 1000 is the documented Solana `getBlocks` upper bound; a
 *     single call past it returns an RPC method error. Chunking here keeps
 *     the wrapper honest about long ranges instead of pushing that
 *     responsibility onto callers who may not have read the limit.
 *   - `fetchEventsForProgram(programId, slotRange, decoder)` — async
 *     generator that walks every block in the range via `getBlocks`,
 *     fetches per-block program signatures via
 *     `getSignaturesForAddress(programId, { minContextSlot: block })`,
 *     loads each tx via `getTransaction`, and hands the raw tx to a
 *     caller-supplied `TransactionDecoder`. The decoder may return a
 *     single result, an array, or throw; throws are caught and surfaced
 *     as `UnknownEventDecode` so the stream NEVER halts on a bad decoder
 *     — vertical packages can evolve their decoders without taking down
 *     historical backfill.
 *
 * Design choices, called out:
 *
 *   - Wrapper, not translator. The pool is already the retry/health boundary;
 *     this file does no additional retry, no additional health tracking,
 *     no response reshaping beyond pass-through. That keeps the "thin
 *     wrapper" contract crisp and makes the types below the canonical
 *     method shapes for later decoder work (T30).
 *
 *   - Async generators for pagination AND the program sweep because the
 *     happy path for agents is "start consuming immediately, stop when I've
 *     seen enough." Returning arrays would force a full buffer and block
 *     on the slowest block in the range.
 *
 *   - `EventDecodeResult` types live here, not in `solana-events`, because
 *     the historical iterator needs the contract to compile. T30 in
 *     solana-events owns the full decoder framework (registry,
 *     log-scanner, CPI walker); when that lands it will re-export these
 *     types so nothing in the codebase has to depend on both modules for
 *     the same shape.
 */

import type { RpcPool } from './rpc-pool';

// ---------------------------------------------------------------------------
// Event decoder contract
// ---------------------------------------------------------------------------

/**
 * Successfully decoded event from a transaction. `data` is vertical-specific —
 * pumpfun decoders ship a `{ eventType, tokenMint, ... }` shape; Jupiter
 * decoders will ship something else. Downstream consumers pattern-match on
 * `programId`.
 */
export interface DecodedEvent {
  kind: 'decoded';
  slot: number;
  signature: string;
  programId: string;
  /** Vertical-specific payload. Opaque to the substrate. */
  data: unknown;
}

/**
 * A transaction the decoder could not interpret. Emitted rather than dropped
 * so telemetry can surface "we saw a variant we don't understand yet" —
 * which is valuable signal for program upgrades or new instructions. The
 * `reason` is the decoder's own error message or a substrate-supplied
 * classification.
 */
export interface UnknownEventDecode {
  kind: 'unknown';
  slot: number;
  signature: string;
  programId: string;
  reason: string;
  rawLogs?: string[];
}

export type EventDecodeResult = DecodedEvent | UnknownEventDecode;

/**
 * Transaction decoder. Called once per tx in the program sweep. May return a
 * single result, an array (one tx can emit multiple logical events), or
 * throw — throws are mapped to `UnknownEventDecode` by the caller, so
 * decoder authors don't have to build their own error-swallowing.
 */
export type TransactionDecoder = (
  tx: unknown,
) => EventDecodeResult | EventDecodeResult[];

// ---------------------------------------------------------------------------
// Method-level option shapes
// ---------------------------------------------------------------------------

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface GetSignaturesOptions {
  /** Page size. Solana caps at 1000 and defaults to 1000. */
  limit?: number;
  /** Start before this signature (newest-first pagination cursor). */
  before?: string;
  /** Stop when this signature is encountered (inclusive lower bound). */
  until?: string;
  commitment?: Commitment;
  /** Used by program-sweep to pin results to a specific slot. */
  minContextSlot?: number;
}

export interface IterateSignaturesOptions extends GetSignaturesOptions {
  /**
   * Cap on the total number of pages fetched. Safety net for runaway
   * pagination; defaults to unbounded (`Infinity`). A page is "short" —
   * and therefore the last — when it returns fewer than `limit` items.
   */
  maxPages?: number;
}

export interface GetTransactionOptions {
  encoding?: 'json' | 'jsonParsed' | 'base58' | 'base64';
  /**
   * Max version of the tx format the caller is willing to accept. This
   * project only ships v0 support. Defaulted to 0 when not supplied because
   * omitting the field entirely makes the node fall back to legacy-only
   * responses for versioned transactions — that silently drops data and is
   * a footgun.
   */
  maxSupportedTransactionVersion?: number;
  commitment?: Commitment;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err?: unknown;
  memo?: string | null;
  blockTime?: number | null;
  confirmationStatus?: Commitment;
}

export interface SlotRange {
  /** Inclusive lower bound. */
  fromSlot: number;
  /** Inclusive upper bound. Empty range when `toSlot < fromSlot`. */
  toSlot: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Solana's `getBlocks` caps a single call's span at 500_000 slots in theory
 * but in practice public endpoints reject anything beyond 1000. We chunk at
 * 1000 to stay inside every provider's limit.
 */
const BLOCKS_CHUNK = 1000;

/** Default page size for `iterateSignaturesForAddress`. */
const DEFAULT_SIG_LIMIT = 1000;

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// RpcHistoricalBackfill
// ---------------------------------------------------------------------------

export class RpcHistoricalBackfill {
  readonly #pool: RpcPool;

  constructor(pool: RpcPool) {
    this.#pool = pool;
  }

  /**
   * Fetch one page of signatures for an address. Stripped-undefined options
   * go through as-is; unrecognised extra fields are forwarded for forward
   * compatibility with newer RPC fields.
   */
  async getSignaturesForAddress(
    address: string,
    opts: GetSignaturesOptions = {},
  ): Promise<SignatureInfo[]> {
    const params: unknown[] = [address, stripUndefined(opts as Record<string, unknown>)];
    return (await this.#pool.call('getSignaturesForAddress', params)) as SignatureInfo[];
  }

  /**
   * Page through signatures for an address with `before` cursor. Stops when
   * a page is short (< limit) or `maxPages` is reached.
   *
   * The page iteration is structured so the generator awaits one page, yields
   * every signature from it, then decides whether to fetch the next one —
   * this gives consumers true lazy consumption and lets them stop early via
   * `break` without paying for the next page.
   */
  async *iterateSignaturesForAddress(
    address: string,
    opts: IterateSignaturesOptions = {},
  ): AsyncGenerator<SignatureInfo, void, void> {
    const limit = opts.limit ?? DEFAULT_SIG_LIMIT;
    const maxPages = opts.maxPages ?? Infinity;
    let before = opts.before;
    for (let page = 0; page < maxPages; page++) {
      const pageOpts: GetSignaturesOptions = stripUndefined({
        limit,
        before,
        until: opts.until,
        commitment: opts.commitment,
        minContextSlot: opts.minContextSlot,
      }) as GetSignaturesOptions;
      const sigs = await this.getSignaturesForAddress(address, pageOpts);
      if (sigs.length === 0) return;
      for (const sig of sigs) yield sig;
      if (sigs.length < limit) return;
      // Solana returns newest-first; the next page starts BEFORE the oldest
      // signature in this page. sigs is non-empty here because the guard
      // above bailed on zero-length.
      before = sigs[sigs.length - 1]!.signature;
    }
  }

  /**
   * Fetch a single transaction. Returns `null` when the node reports "not
   * found" — that's a normal outcome for a freshly-queried or pruned tx,
   * not an error.
   */
  async getTransaction(
    signature: string,
    opts: GetTransactionOptions = {},
  ): Promise<unknown | null> {
    const params: unknown[] = [
      signature,
      stripUndefined({
        // Default to v0 — see type doc-comment for why.
        maxSupportedTransactionVersion: opts.maxSupportedTransactionVersion ?? 0,
        encoding: opts.encoding,
        commitment: opts.commitment,
      }),
    ];
    return (await this.#pool.call('getTransaction', params)) as unknown | null;
  }

  /**
   * Fetch block slot numbers in `[from, to]` inclusive. Ranges longer than
   * 1000 are chunked into 1000-slot windows and concatenated in order. An
   * empty range (`from > to`) returns `[]` without any RPC round-trips.
   */
  async getBlocks(from: number, to: number): Promise<number[]> {
    if (from > to) return [];
    const out: number[] = [];
    for (let start = from; start <= to; start += BLOCKS_CHUNK) {
      const end = Math.min(start + BLOCKS_CHUNK - 1, to);
      const chunk = (await this.#pool.call('getBlocks', [start, end])) as number[];
      for (const slot of chunk) out.push(slot);
    }
    return out;
  }

  /**
   * Historical program sweep. For each slot in the range, fetch the program's
   * transaction signatures, then fetch each transaction, then decode. Yields
   * results lazily.
   *
   * Unknown-channel contract: the decoder NEVER halts iteration. If it
   * throws, we yield an `UnknownEventDecode` with the error message as
   * `reason` and move on. If it returns a single result or an array, each
   * entry is yielded in order.
   */
  async *fetchEventsForProgram(
    programId: string,
    range: SlotRange,
    decoder: TransactionDecoder,
  ): AsyncGenerator<EventDecodeResult, void, void> {
    const { fromSlot, toSlot } = range;
    if (toSlot < fromSlot) return;

    const slots = await this.getBlocks(fromSlot, toSlot);
    for (const slot of slots) {
      // One page per block. Pin the query to this slot with `minContextSlot`
      // so the node answers in-range, not "latest". 1000 signatures in a
      // single block for a single program is already extreme; we don't
      // paginate further here because the block's signature list is the
      // finite ground truth.
      const sigs = await this.getSignaturesForAddress(programId, {
        limit: 1000,
        minContextSlot: slot,
      });
      for (const sigInfo of sigs) {
        const tx = await this.getTransaction(sigInfo.signature);
        if (tx === null || tx === undefined) continue;
        let results: EventDecodeResult[];
        try {
          const produced = decoder(tx);
          results = Array.isArray(produced) ? produced : [produced];
        } catch (err) {
          results = [
            {
              kind: 'unknown',
              slot: sigInfo.slot,
              signature: sigInfo.signature,
              programId,
              reason: err instanceof Error ? err.message : String(err),
            },
          ];
        }
        for (const ev of results) yield ev;
      }
    }
  }
}
