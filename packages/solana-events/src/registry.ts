/**
 * Event decoder registry.
 *
 * The substrate owns the framework for turning parsed log trees into typed
 * events. Vertical packages (`@ap3x/pumpfun-protocol`, future Raydium / Orca
 * packages, etc.) register a {@link ProgramDecoder} for each program they
 * understand; anything without a registered decoder surfaces as a typed
 * {@link UnknownEventDecode} record rather than being silently dropped.
 *
 * The registry is structural-type based: a decoder is just an object with a
 * `programId` and a `decode(chunk)` method. No base class, no plugin ritual.
 */

import type { PublicKey } from '@ap3x/solana-core';

import type {
  LogParseError,
  ProgramLogChunk,
  TransactionLog,
} from './parse-logs';

/**
 * Vertical-supplied decoder for a single program. Implementations return
 * their typed event union, or an {@link UnknownEventDecode} record when the
 * chunk is recognized as the right program but uses an unknown variant
 * (e.g. a new instruction the vertical hasn't modeled yet).
 */
export interface ProgramDecoder<TEvent = unknown> {
  /** The program this decoder handles. */
  programId: PublicKey;
  /**
   * Decode a single invocation's log chunk. Children are not walked
   * automatically — the registry handles recursion so each CPI frame is
   * resolved against whichever decoder matches its programId.
   */
  decode(chunk: ProgramLogChunk): TEvent | UnknownEventDecode;
}

/**
 * Structured "we saw this, but couldn't decode it" record. These are first
 * class citizens of the event stream — never silently dropped, always
 * surfaced on both the full event list and a dedicated `unknown` channel so
 * consumers can monitor decoder coverage.
 */
export interface UnknownEventDecode {
  kind: 'unknown';
  /** Program ID the chunk belongs to, in base58. */
  programId: string;
  /** Short explanation: `no decoder registered`, decoder threw, etc. */
  reason: string;
  /** The raw log lines from the chunk, if available, for debugging. */
  rawLines?: string[];
}

/** Successful decode. `data` is the vertical's typed event. */
export interface DecodedEvent<TEvent = unknown> {
  kind: 'decoded';
  programId: string;
  data: TEvent;
}

/** Discriminated union of every per-chunk outcome. */
export type EventUnion = DecodedEvent | UnknownEventDecode;

/**
 * Aggregate result of decoding a {@link TransactionLog}:
 * - `events`: every chunk's outcome in DFS order (decoded + unknown mixed)
 * - `unknown`: the subset of `events` that are {@link UnknownEventDecode}
 * - `parseErrors`: forwarded from the log parser unchanged
 */
export interface DecodedEventStream {
  events: EventUnion[];
  unknown: UnknownEventDecode[];
  parseErrors: LogParseError[];
}

/**
 * Registry for per-program decoders. Construct once, `register()` each
 * decoder, then call `decode()` on parsed transaction logs to get a typed
 * event stream back.
 */
export class EventDecoderRegistry {
  // Map key is the program's base58 string. Using strings keeps lookup
  // trivial; callers can register with either a PublicKey or a raw string.
  private readonly decoders = new Map<string, ProgramDecoder>();

  /**
   * Register a decoder. Accepts either a `PublicKey` or its base58 form so
   * callers can avoid importing `PublicKey` just to register a decoder they
   * already identify by string constant.
   *
   * Replaces any existing decoder for the same program ID. Returns `this`
   * for fluent chaining.
   */
  register<T>(
    programId: PublicKey | string,
    decoder: ProgramDecoder<T>,
  ): this {
    const key = typeof programId === 'string' ? programId : programId.toBase58();
    this.decoders.set(key, decoder as ProgramDecoder);
    return this;
  }

  /** Whether a decoder is registered for the given program. */
  has(programId: PublicKey | string): boolean {
    const key = typeof programId === 'string' ? programId : programId.toBase58();
    return this.decoders.has(key);
  }

  /**
   * Walk every chunk in DFS order and apply the matching decoder. Chunks
   * whose programId has no registered decoder produce an
   * {@link UnknownEventDecode} with `reason: 'no decoder registered'`.
   *
   * Decoder exceptions are caught and also surface as `UnknownEventDecode`,
   * with the error message in `reason`. This keeps one buggy decoder from
   * taking down decoding for every other program in the transaction.
   */
  decode(transactionLog: TransactionLog): DecodedEventStream {
    const events: EventUnion[] = [];
    const unknown: UnknownEventDecode[] = [];

    const walk = (chunk: ProgramLogChunk): void => {
      const decoder = this.decoders.get(chunk.programId);
      if (!decoder) {
        const u: UnknownEventDecode = {
          kind: 'unknown',
          programId: chunk.programId,
          reason: 'no decoder registered',
          rawLines: chunk.rawLines,
        };
        events.push(u);
        unknown.push(u);
      } else {
        try {
          const result = decoder.decode(chunk);
          if (
            result !== null &&
            typeof result === 'object' &&
            'kind' in result &&
            (result as { kind: string }).kind === 'unknown'
          ) {
            // Decoder explicitly returned an unknown record — trust it, but
            // ensure programId is populated so consumers don't have to dig.
            const u = result as UnknownEventDecode;
            const resolved: UnknownEventDecode = {
              kind: 'unknown',
              programId: u.programId || chunk.programId,
              reason: u.reason,
              rawLines: u.rawLines ?? chunk.rawLines,
            };
            events.push(resolved);
            unknown.push(resolved);
          } else {
            events.push({
              kind: 'decoded',
              programId: chunk.programId,
              data: result,
            });
          }
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          const u: UnknownEventDecode = {
            kind: 'unknown',
            programId: chunk.programId,
            reason: `decoder threw: ${reason}`,
            rawLines: chunk.rawLines,
          };
          events.push(u);
          unknown.push(u);
        }
      }
      for (const child of chunk.children) {
        walk(child);
      }
    };

    for (const chunk of transactionLog.chunks) {
      walk(chunk);
    }

    return { events, unknown, parseErrors: transactionLog.parseErrors };
  }
}
