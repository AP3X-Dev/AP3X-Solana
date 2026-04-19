/**
 * Solana transaction log parser.
 *
 * Solana program execution produces a flat array of log lines that encode a
 * nested structure via `invoke [<depth>]` / `success` / `failed` markers. The
 * lines we care about follow a handful of patterns:
 *
 *   Program <id> invoke [<depth>]        -- begin program execution
 *   Program log: <message>               -- free-form human-readable log
 *   Program data: <base64>               -- structured event data
 *   Program <id> success                 -- end of successful invocation
 *   Program <id> failed: <reason>        -- end of failed invocation
 *
 * `parseLogs` turns this flat array into a tree of {@link ProgramLogChunk}s,
 * one per invocation, preserving CPI depth. Malformed lines never throw —
 * they surface as {@link LogParseError} records alongside the parsed tree.
 *
 * Zero runtime deps. `Program data:` base64 payloads are decoded via Node's
 * `Buffer.from(s, 'base64')`, which is part of the Node runtime and not an
 * external npm package.
 */

/**
 * A single program invocation in a Solana transaction log. Invocations nest:
 * a top-level program may CPI into another program, which may CPI further.
 * Each level produces its own chunk, linked via {@link children}.
 */
export interface ProgramLogChunk {
  /** Program ID in base58 — taken verbatim from the invoke line. */
  programId: string;
  /**
   * 1-indexed depth as reported by the runtime. Top-level invocations report
   * depth 1; CPIs one level deep report depth 2; etc.
   */
  depth: number;
  /**
   * Whether the invocation completed with `Program <id> success`. When the
   * underlying log ended without a matching success/failed marker (truncated
   * trace), we synthesize `success: false` with `failureReason: 'truncated'`.
   */
  success: boolean;
  /** Human-readable failure reason when {@link success} is `false`. */
  failureReason?: string;
  /** `Program log:` lines (with the prefix stripped). */
  logs: string[];
  /** Decoded `Program data:` payloads — base64 decoded into raw bytes. */
  dataPayloads: Uint8Array[];
  /** Nested CPI chunks, in order of appearance. */
  children: ProgramLogChunk[];
  /**
   * Every line observed between this chunk's invoke and its terminator,
   * including log/data lines. Useful for debugging and for decoders that want
   * to re-parse the raw trace.
   */
  rawLines: string[];
}

/** Describes a line the parser could not classify. */
export interface LogParseError {
  /** Zero-based line index into the original logs array. */
  lineIndex: number;
  /** The offending line, unchanged. */
  line: string;
  /** Short machine-readable explanation. */
  reason: string;
}

/** Result of {@link parseLogs}. */
export interface TransactionLog {
  /** Top-level invocations (depth 1). */
  chunks: ProgramLogChunk[];
  /** Lines that did not fit any recognized pattern. */
  parseErrors: LogParseError[];
}

// ---------------------------------------------------------------------------
// Line patterns
// ---------------------------------------------------------------------------

// base58 program IDs are 32-44 chars from the Bitcoin alphabet. We accept the
// broader alphanumeric character class here; validation (if desired) is a
// consumer concern — the log parser itself is lenient by design.
const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const SUCCESS_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) success$/;
const FAILED_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: (.+)$/;
const LOG_RE = /^Program log: (.*)$/;
const DATA_RE = /^Program data: ([A-Za-z0-9+/=]+)$/;

/**
 * Decode a base64 string into raw bytes. Exposed as a standalone helper so
 * consumers can decode `Program data:` fragments they pull out of
 * {@link ProgramLogChunk.rawLines} without re-implementing base64.
 *
 * @throws Error if the string contains non-base64 characters or invalid
 *         padding. Node's `Buffer.from` is lenient, so we validate explicitly.
 */
export function decodeBase64Data(s: string): Uint8Array {
  // Buffer.from silently drops invalid chars; validate first so callers get
  // a clear error instead of a corrupted payload.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new Error(`decodeBase64Data: invalid base64 input`);
  }
  // Padding must be correct length (total length multiple of 4 after padding).
  if (s.length % 4 !== 0) {
    throw new Error(`decodeBase64Data: invalid base64 padding`);
  }
  const buf = Buffer.from(s, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Parse a Solana transaction log array into a tree of program invocations.
 *
 * The parser is stack-based: each `invoke` pushes a new chunk whose parent is
 * the top of the stack (or the root if the stack is empty); each `success` /
 * `failed` pops. Mismatched terminators (popping the empty stack, or popping
 * a chunk whose programId doesn't match the terminator) surface as
 * {@link LogParseError}s but never crash the parser.
 *
 * Truncated traces (an invoke without a matching terminator when the log
 * ends) produce a chunk with `success: false` and `failureReason: 'truncated'`
 * so consumers can distinguish them from explicit failures.
 */
export function parseLogs(logs: string[]): TransactionLog {
  const roots: ProgramLogChunk[] = [];
  const stack: ProgramLogChunk[] = [];
  const parseErrors: LogParseError[] = [];

  const top = (): ProgramLogChunk | undefined => stack[stack.length - 1];

  for (let i = 0; i < logs.length; i++) {
    const line = logs[i];
    // `noUncheckedIndexedAccess` forces this narrowing — the loop bound
    // guarantees the index is in range, but TypeScript doesn't model that.
    if (line === undefined) continue;

    const invokeMatch = line.match(INVOKE_RE);
    if (invokeMatch) {
      const programId = invokeMatch[1] as string;
      const depthStr = invokeMatch[2] as string;
      const chunk: ProgramLogChunk = {
        programId,
        depth: Number(depthStr),
        success: false,
        logs: [],
        dataPayloads: [],
        children: [],
        // The invoke line belongs to this chunk's raw trace — it's how the
        // chunk starts. Callers reconstructing the trace from a single chunk
        // should see it.
        rawLines: [line],
      };
      const parent = top();
      if (parent) {
        parent.children.push(chunk);
        // And also to the parent's raw trace, so the parent's rawLines is a
        // complete record of every line that appeared during its execution
        // window (including nested events).
        parent.rawLines.push(line);
      } else {
        roots.push(chunk);
      }
      stack.push(chunk);
      continue;
    }

    const successMatch = line.match(SUCCESS_RE);
    if (successMatch) {
      const programId = successMatch[1] as string;
      const current = top();
      if (!current) {
        parseErrors.push({
          lineIndex: i,
          line,
          reason: 'success without matching invoke',
        });
        continue;
      }
      if (current.programId !== programId) {
        parseErrors.push({
          lineIndex: i,
          line,
          reason: `programId mismatch on success: expected ${current.programId}, got ${programId}`,
        });
        // Still pop — the runtime's view is what it is; keeping the stack
        // wedged would cascade into further spurious errors.
      }
      current.success = true;
      current.rawLines.push(line);
      stack.pop();
      // Success markers for nested CPIs also appear in the parent's trace.
      const parent = top();
      if (parent) parent.rawLines.push(line);
      continue;
    }

    const failedMatch = line.match(FAILED_RE);
    if (failedMatch) {
      const programId = failedMatch[1] as string;
      const reason = failedMatch[2] as string;
      const current = top();
      if (!current) {
        parseErrors.push({
          lineIndex: i,
          line,
          reason: 'failed without matching invoke',
        });
        continue;
      }
      if (current.programId !== programId) {
        parseErrors.push({
          lineIndex: i,
          line,
          reason: `programId mismatch on failed: expected ${current.programId}, got ${programId}`,
        });
      }
      current.success = false;
      current.failureReason = reason;
      current.rawLines.push(line);
      stack.pop();
      const parent = top();
      if (parent) parent.rawLines.push(line);
      continue;
    }

    const logMatch = line.match(LOG_RE);
    if (logMatch) {
      const current = top();
      if (!current) {
        parseErrors.push({
          lineIndex: i,
          line,
          reason: 'log line outside any invocation',
        });
        continue;
      }
      current.logs.push(logMatch[1] as string);
      current.rawLines.push(line);
      continue;
    }

    const dataMatch = line.match(DATA_RE);
    if (dataMatch) {
      const current = top();
      if (!current) {
        parseErrors.push({
          lineIndex: i,
          line,
          reason: 'data line outside any invocation',
        });
        continue;
      }
      try {
        current.dataPayloads.push(decodeBase64Data(dataMatch[1] as string));
        current.rawLines.push(line);
      } catch (e) {
        parseErrors.push({
          lineIndex: i,
          line,
          reason: `invalid base64 in Program data: ${(e as Error).message}`,
        });
      }
      continue;
    }

    // Unrecognized: record the error, but if an invocation is open keep the
    // raw line so consumers can still reconstruct the full trace.
    parseErrors.push({
      lineIndex: i,
      line,
      reason: 'unrecognized line pattern',
    });
    const current = top();
    if (current) {
      current.rawLines.push(line);
    }
  }

  // Truncated invocations: any chunk still on the stack never saw its
  // success/failed marker. Synthesize a failure so callers don't confuse
  // "trace cut off" with "program succeeded silently".
  while (stack.length > 0) {
    const current = stack.pop() as ProgramLogChunk;
    current.success = false;
    current.failureReason = 'truncated';
  }

  return { chunks: roots, parseErrors };
}
