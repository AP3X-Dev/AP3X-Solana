import { describe, it, expect } from 'vitest';

import type { ProgramLogChunk } from './parse-logs';
import { parseLogs, decodeBase64Data } from './parse-logs';

// Real program IDs used as fixtures — base58, 32-44 chars. Using recognizable
// mainnet programs keeps the test data grounded without requiring network.
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

// Narrow `T | undefined` to `T`, throwing a readable message on failure so
// downstream property access is safe. Keeps tests readable under
// `noUncheckedIndexedAccess` without `!` everywhere.
function assertDefined<T>(value: T | undefined, name = 'value'): T {
  if (value === undefined) {
    throw new Error(`expected ${name} to be defined`);
  }
  return value;
}

describe('parseLogs', () => {
  it('parses a simple top-level invoke + log + success', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program log: hello`,
      `Program ${TOKEN} success`,
    ]);

    expect(result.parseErrors).toEqual([]);
    expect(result.chunks).toHaveLength(1);
    const chunk = assertDefined(result.chunks[0], 'chunk');
    expect(chunk.programId).toBe(TOKEN);
    expect(chunk.depth).toBe(1);
    expect(chunk.success).toBe(true);
    expect(chunk.logs).toEqual(['hello']);
    expect(chunk.dataPayloads).toEqual([]);
    expect(chunk.children).toEqual([]);
    expect(chunk.rawLines).toEqual([
      `Program ${TOKEN} invoke [1]`,
      `Program log: hello`,
      `Program ${TOKEN} success`,
    ]);
  });

  it('parses a 3-level nested CPI tree', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${ATA} invoke [2]`,
      `Program ${METAPLEX} invoke [3]`,
      `Program ${METAPLEX} success`,
      `Program ${ATA} success`,
      `Program ${TOKEN} success`,
    ]);

    expect(result.parseErrors).toEqual([]);
    expect(result.chunks).toHaveLength(1);
    const outer = assertDefined(result.chunks[0], 'outer');
    expect(outer.programId).toBe(TOKEN);
    expect(outer.depth).toBe(1);
    expect(outer.success).toBe(true);
    expect(outer.children).toHaveLength(1);

    const middle = assertDefined(outer.children[0], 'middle');
    expect(middle.programId).toBe(ATA);
    expect(middle.depth).toBe(2);
    expect(middle.success).toBe(true);
    expect(middle.children).toHaveLength(1);

    const inner = assertDefined(middle.children[0], 'inner');
    expect(inner.programId).toBe(METAPLEX);
    expect(inner.depth).toBe(3);
    expect(inner.success).toBe(true);
    expect(inner.children).toEqual([]);
  });

  it('marks failed inner invoke while outer still succeeds', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${ATA} invoke [2]`,
      `Program log: about to blow up`,
      `Program ${ATA} failed: custom program error: 0x1`,
      `Program ${TOKEN} success`,
    ]);

    expect(result.parseErrors).toEqual([]);
    const outer = assertDefined(result.chunks[0], 'outer');
    expect(outer.success).toBe(true);
    const inner = assertDefined(outer.children[0], 'inner');
    expect(inner.success).toBe(false);
    expect(inner.failureReason).toBe('custom program error: 0x1');
    expect(inner.logs).toEqual(['about to blow up']);
  });

  it('decodes Program data base64 payloads', () => {
    // 'Hello' in base64 is 'SGVsbG8='.
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program data: SGVsbG8=`,
      `Program ${TOKEN} success`,
    ]);

    expect(result.parseErrors).toEqual([]);
    const chunk = assertDefined(result.chunks[0], 'chunk');
    expect(chunk.dataPayloads).toHaveLength(1);
    const payload = assertDefined(chunk.dataPayloads[0], 'payload');
    expect(new TextDecoder().decode(payload)).toBe('Hello');
  });

  it('handles mixed logs, data, and nested invocations', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program log: initializing`,
      `Program data: SGVsbG8=`,
      `Program ${ATA} invoke [2]`,
      `Program log: ata called`,
      `Program ${ATA} success`,
      `Program log: finishing`,
      `Program ${TOKEN} success`,
    ]);

    expect(result.parseErrors).toEqual([]);
    const outer = assertDefined(result.chunks[0], 'outer');
    expect(outer.logs).toEqual(['initializing', 'finishing']);
    expect(outer.dataPayloads).toHaveLength(1);
    expect(outer.children).toHaveLength(1);
    const inner = assertDefined(outer.children[0], 'inner');
    expect(inner.logs).toEqual(['ata called']);
    // rawLines captures the entire interval for the outer chunk, including
    // the inner invoke / success lines.
    expect(outer.rawLines).toContain(`Program ${ATA} invoke [2]`);
    expect(outer.rawLines).toContain(`Program ${ATA} success`);
  });

  it('records LogParseError for malformed lines but keeps parsing', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `totally bogus line`,
      `Program log: survived`,
      `Program ${TOKEN} success`,
    ]);

    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors[0]).toMatchObject({
      lineIndex: 1,
      line: 'totally bogus line',
      reason: 'unrecognized line pattern',
    });

    const chunk = assertDefined(result.chunks[0], 'chunk');
    expect(chunk.logs).toEqual(['survived']);
    // The malformed line is preserved in rawLines since the chunk was open.
    expect(chunk.rawLines).toContain('totally bogus line');
  });

  it('flags success without matching invoke', () => {
    const result = parseLogs([`Program ${TOKEN} success`]);
    expect(result.chunks).toEqual([]);
    expect(result.parseErrors).toHaveLength(1);
    const err = assertDefined(result.parseErrors[0], 'parseError');
    expect(err.reason).toBe('success without matching invoke');
  });

  it('flags failed without matching invoke', () => {
    const result = parseLogs([`Program ${TOKEN} failed: boom`]);
    expect(result.chunks).toEqual([]);
    expect(result.parseErrors).toHaveLength(1);
    const err = assertDefined(result.parseErrors[0], 'parseError');
    expect(err.reason).toBe('failed without matching invoke');
  });

  it('flags programId mismatch on success', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${ATA} success`,
    ]);
    expect(result.parseErrors).toHaveLength(1);
    const err = assertDefined(result.parseErrors[0], 'parseError');
    expect(err.reason).toContain('programId mismatch');
  });

  it('flags programId mismatch on failed', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${ATA} failed: wrong`,
    ]);
    expect(result.parseErrors).toHaveLength(1);
    const err = assertDefined(result.parseErrors[0], 'parseError');
    expect(err.reason).toContain('programId mismatch');
  });

  it('returns empty result for empty input', () => {
    expect(parseLogs([])).toEqual({ chunks: [], parseErrors: [] });
  });

  it('marks truncated invocations as failed with reason=truncated', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program log: cut off`,
    ]);
    expect(result.parseErrors).toEqual([]);
    const chunk: ProgramLogChunk = assertDefined(result.chunks[0], 'chunk');
    expect(chunk.success).toBe(false);
    expect(chunk.failureReason).toBe('truncated');
    expect(chunk.logs).toEqual(['cut off']);
  });

  it('flags log lines outside any invocation', () => {
    const result = parseLogs([`Program log: orphan`]);
    expect(result.parseErrors).toHaveLength(1);
    const err = assertDefined(result.parseErrors[0], 'parseError');
    expect(err.reason).toBe('log line outside any invocation');
  });

  it('flags data lines outside any invocation', () => {
    const result = parseLogs([`Program data: SGVsbG8=`]);
    expect(result.parseErrors).toHaveLength(1);
    const err = assertDefined(result.parseErrors[0], 'parseError');
    expect(err.reason).toBe('data line outside any invocation');
  });

  it('flags invalid base64 in Program data as parse error', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      // 'A=AA' matches DATA_RE (4 chars, all in alphabet) but fails our
      // strict base64 validator's "padding is trailing only" rule.
      `Program data: A=AA`,
      `Program ${TOKEN} success`,
    ]);
    // chunk exists, but payload did not decode.
    expect(result.chunks).toHaveLength(1);
    const chunk = assertDefined(result.chunks[0], 'chunk');
    expect(chunk.dataPayloads).toEqual([]);
    expect(result.parseErrors).toHaveLength(1);
    const err = assertDefined(result.parseErrors[0], 'parseError');
    expect(err.reason).toContain('invalid base64');
  });

  it('handles two sequential top-level invocations', () => {
    const result = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${TOKEN} success`,
      `Program ${ATA} invoke [1]`,
      `Program ${ATA} success`,
    ]);
    expect(result.parseErrors).toEqual([]);
    expect(result.chunks).toHaveLength(2);
    const first = assertDefined(result.chunks[0], 'first');
    const second = assertDefined(result.chunks[1], 'second');
    expect(first.programId).toBe(TOKEN);
    expect(second.programId).toBe(ATA);
  });
});

describe('decodeBase64Data', () => {
  it('round-trips ASCII content', () => {
    const encoded = Buffer.from('hello world').toString('base64');
    const decoded = decodeBase64Data(encoded);
    expect(new TextDecoder().decode(decoded)).toBe('hello world');
  });

  it('round-trips binary content', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
    const encoded = Buffer.from(bytes).toString('base64');
    const decoded = decodeBase64Data(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('accepts an empty string', () => {
    const decoded = decodeBase64Data('');
    expect(decoded.length).toBe(0);
  });

  it('throws on invalid base64 characters', () => {
    expect(() => decodeBase64Data('not*valid!')).toThrow(/invalid base64/);
  });

  it('throws on invalid padding length', () => {
    // 3 chars — not a multiple of 4 even after implicit padding accounting.
    expect(() => decodeBase64Data('AAA')).toThrow(/invalid base64/);
  });

  it('accepts proper padding', () => {
    // 'A' padded to 4 chars.
    const decoded = decodeBase64Data('QQ==');
    expect(decoded.length).toBe(1);
    expect(decoded[0]).toBe(0x41); // 'A'
  });
});
