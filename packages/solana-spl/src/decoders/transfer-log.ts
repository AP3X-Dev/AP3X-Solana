/**
 * SPL Token transfer log decoder.
 *
 * Parses a `Program data:` line out of a program invocation chunk and
 * delegates to {@link decodeTransferInstruction} to extract transfer fields.
 *
 * This module defines its own `ProgramLogChunk` interface — a local structural
 * type — because `@ap3x/solana-spl` is not permitted to import from
 * `@ap3x/solana-events` (boundary rule: spl → core, tx only). Callers that
 * hold a `ProgramLogChunk` from `@ap3x/solana-events` can pass it directly;
 * TypeScript's structural typing ensures compatibility.
 *
 * Zero ecosystem deps.
 */

import { PublicKey } from '@ap3x/solana-core';
import {
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  decodeTransferInstruction,
  type DecodedTransfer,
} from './transfer-instruction.js';

/**
 * Structural representation of one program invocation, as produced by the
 * `parseLogs` function in `@ap3x/solana-events`. Defined locally here to
 * avoid a cross-layer import.
 *
 * The `programId` field intentionally uses `PublicKey` rather than `string`
 * because the decoder-chain consumers supply resolved keys, not raw base58.
 */
export interface ProgramLogChunk {
  programId: PublicKey;
  accounts: PublicKey[];
  /** `Program log:` and `Program data:` lines, prefixes intact. */
  logs: string[];
  /** Nested CPI chunks. */
  inner: ProgramLogChunk[];
}

const PROGRAM_DATA_PREFIX = 'Program data: ';

/**
 * Parse a `Program data:` log line from `chunk.logs` and decode it as an SPL
 * Token transfer instruction.
 *
 * @returns Decoded transfer fields from the first matching data line, or
 *   `null` when the chunk belongs to a different program, contains no
 *   `Program data:` line, or the data does not decode as a transfer.
 */
export function parseTransferLog(chunk: ProgramLogChunk): DecodedTransfer | null {
  if (
    !chunk.programId.equals(SPL_TOKEN_PROGRAM_ID) &&
    !chunk.programId.equals(SPL_TOKEN_2022_PROGRAM_ID)
  ) {
    return null;
  }
  for (const line of chunk.logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length);
    let data: Uint8Array;
    try {
      data = base64ToBytes(b64);
    } catch {
      continue;
    }
    const decoded = decodeTransferInstruction({
      programId: chunk.programId,
      accounts: chunk.accounts,
      data,
    });
    if (decoded) return decoded;
  }
  return null;
}

/**
 * Decode a base64 string into a Uint8Array using `atob`, which is available
 * in Node 16+ globals and all modern browsers.
 *
 * Uses the same approach as `holder-queries.ts:base64ToBytes` to stay
 * browser-compatible without pulling in Node's `Buffer`.
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
