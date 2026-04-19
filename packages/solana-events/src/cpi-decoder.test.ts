import { describe, it, expect } from 'vitest';

import { parseLogs } from './parse-logs';
import { walkInvocations, decodeBase64Data } from './cpi-decoder';

function assertDefined<T>(value: T | undefined, name = 'value'): T {
  if (value === undefined) {
    throw new Error(`expected ${name} to be defined`);
  }
  return value;
}

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

describe('walkInvocations', () => {
  it('yields the single top-level chunk with depth=1 and a one-element path', () => {
    const tx = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${TOKEN} success`,
    ]);
    const steps = Array.from(walkInvocations(tx));
    expect(steps).toHaveLength(1);
    const step = assertDefined(steps[0], 'step');
    expect(step.depth).toBe(1);
    expect(step.path).toEqual([TOKEN]);
    expect(step.chunk.programId).toBe(TOKEN);
  });

  it('yields chunks in DFS pre-order for nested CPIs', () => {
    // TOKEN -> ATA -> METAPLEX (3-level nesting)
    const tx = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${ATA} invoke [2]`,
      `Program ${METAPLEX} invoke [3]`,
      `Program ${METAPLEX} success`,
      `Program ${ATA} success`,
      `Program ${TOKEN} success`,
    ]);
    const steps = Array.from(walkInvocations(tx));
    expect(steps.map((s) => s.chunk.programId)).toEqual([
      TOKEN,
      ATA,
      METAPLEX,
    ]);
    expect(steps.map((s) => s.depth)).toEqual([1, 2, 3]);

    // Deepest step's path is the full root-to-leaf sequence.
    const deepest = assertDefined(steps[2], 'deepest');
    expect(deepest.path).toEqual([TOKEN, ATA, METAPLEX]);
  });

  it('yields siblings in order', () => {
    // TOKEN calls ATA then MEMO, each one level deep.
    const tx = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${ATA} invoke [2]`,
      `Program ${ATA} success`,
      `Program ${MEMO} invoke [2]`,
      `Program ${MEMO} success`,
      `Program ${TOKEN} success`,
    ]);
    const steps = Array.from(walkInvocations(tx));
    expect(steps.map((s) => s.chunk.programId)).toEqual([
      TOKEN,
      ATA,
      MEMO,
    ]);
    expect(assertDefined(steps[1], 'ataStep').path).toEqual([TOKEN, ATA]);
    expect(assertDefined(steps[2], 'memoStep').path).toEqual([TOKEN, MEMO]);
  });

  it('handles multiple top-level invocations', () => {
    const tx = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${TOKEN} success`,
      `Program ${ATA} invoke [1]`,
      `Program ${ATA} success`,
    ]);
    const steps = Array.from(walkInvocations(tx));
    expect(steps.map((s) => s.chunk.programId)).toEqual([TOKEN, ATA]);
    expect(assertDefined(steps[0], 'first').path).toEqual([TOKEN]);
    expect(assertDefined(steps[1], 'second').path).toEqual([ATA]);
  });

  it('yields nothing for empty transaction logs', () => {
    const tx = parseLogs([]);
    expect(Array.from(walkInvocations(tx))).toEqual([]);
  });

  it('supports early termination', () => {
    // Confirm the generator shape: we can break out mid-iteration.
    const tx = parseLogs([
      `Program ${TOKEN} invoke [1]`,
      `Program ${ATA} invoke [2]`,
      `Program ${ATA} success`,
      `Program ${TOKEN} success`,
    ]);
    const seen: string[] = [];
    for (const step of walkInvocations(tx)) {
      seen.push(step.chunk.programId);
      if (step.chunk.programId === TOKEN) break;
    }
    expect(seen).toEqual([TOKEN]);
  });
});

describe('decodeBase64Data (re-export)', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 255, 0, 128]);
    const encoded = Buffer.from(bytes).toString('base64');
    const decoded = decodeBase64Data(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('throws on invalid characters', () => {
    expect(() => decodeBase64Data('!!!')).toThrow(/invalid base64/);
  });

  it('throws on invalid padding', () => {
    // Length-5 string — can't be valid base64 regardless of content.
    expect(() => decodeBase64Data('AAAAA')).toThrow(/invalid base64/);
  });
});
