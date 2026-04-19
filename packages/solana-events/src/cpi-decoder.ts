/**
 * CPI (cross-program-invocation) decoder helpers.
 *
 * `parseLogs` produces a tree of {@link ProgramLogChunk}s. This module adds
 * two ergonomic primitives on top of that tree:
 *
 * - {@link walkInvocations} — DFS generator that yields every chunk with its
 *   depth and the programId path from the root. Useful for flat iteration
 *   when a decoder wants to look at every frame (e.g. matching nested SPL
 *   Token transfers that occur inside a vertical program's CPI chain).
 *
 * - {@link decodeBase64Data} — re-exported from `./parse-logs` so consumers
 *   can decode extra base64 content they pull out of raw lines without
 *   reaching into the parser module directly.
 *
 * Both helpers are pure — they operate on already-parsed transaction logs
 * and do no I/O.
 */

import type { ProgramLogChunk, TransactionLog } from './parse-logs';

export { decodeBase64Data } from './parse-logs';
export type { UnknownEventDecode } from './registry';

/**
 * A single step of a DFS walk over the transaction log tree.
 */
export interface InvocationWalkStep {
  /** The chunk at this position in the walk. */
  chunk: ProgramLogChunk;
  /** The chunk's runtime-reported depth (1-indexed, matches `chunk.depth`). */
  depth: number;
  /**
   * Program IDs from root down to and including this chunk, in order. The
   * last element is always `chunk.programId`. Useful for attribution: a
   * decoder seeing a Token Program transfer at depth 3 can consult
   * `path[0]` to see which vertical program originated the call.
   */
  path: string[];
}

/**
 * DFS walk over every invocation in a parsed transaction log. Yields each
 * chunk exactly once, in pre-order (parent before children). Children are
 * yielded in the order they appear in the trace.
 *
 * Implemented as a generator so callers can early-exit (e.g. `for...of` with
 * `break`) and so the whole tree doesn't have to be flattened into memory
 * up front for large traces.
 */
export function* walkInvocations(
  transactionLog: TransactionLog,
): Generator<InvocationWalkStep> {
  function* go(
    chunk: ProgramLogChunk,
    path: string[],
  ): Generator<InvocationWalkStep> {
    yield { chunk, depth: chunk.depth, path };
    for (const child of chunk.children) {
      yield* go(child, [...path, child.programId]);
    }
  }

  for (const chunk of transactionLog.chunks) {
    yield* go(chunk, [chunk.programId]);
  }
}
