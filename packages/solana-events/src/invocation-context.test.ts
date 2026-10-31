import { describe, expect, it } from 'vitest';
import { mapInvocationContext, type InvocationInstruction, type InvocationContextInput } from './invocation-context';

const A = '11111111111111111111111111111111';
const B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const C = 'ComputeBudget111111111111111111111111111111';
const ix = (programId: string, outerIndex = 0, innerIndex: number | null = null, stackHeight: number | null = null): InvocationInstruction =>
  ({ programId, outerIndex, innerIndex, stackHeight });
const open = (id: string, depth = 1) => `Program ${id} invoke [${depth}]`;
const close = (id: string) => `Program ${id} success`;
const input = (instructions: InvocationInstruction[], logMessages: string[]): InvocationContextInput =>
  ({ instructions, logMessages, innerInstructionsRecorded: true, execution: 'succeeded' });

describe('receipt-bound invocation context', () => {
  it('retains log-root ordinals separately from uniquely matched RPC outer indices', () => {
    const result = mapInvocationContext(input([ix(C), ix(A, 1), ix(B, 2)], [open(A), close(A), open(B), close(B)]));
    expect(result.status).toBe('mapped');
    expect(result.invocations.map(i => [i.rootOrdinal, i.outerIndex, i.applied])).toEqual([[0, 1, true], [1, 2, true]]);
    expect(result.untracedInstructions).toEqual([ix(C)]);
  });
  it('preserves nested identity and payload bytes, including multi-slice program data', () => {
    const result = mapInvocationContext(input([ix(A), ix(B, 0, 0, 2)], [open(A), open(B, 2), 'Program data: AQI= AwQ=', close(B), close(A)]));
    expect(result.status).toBe('mapped');
    expect(result.invocations.map(i => [i.traceIndex, i.parentTraceIndex, i.outerIndex, i.innerIndex])).toEqual([[0, null, 0, null], [1, 0, 0, 0]]);
    expect(result.invocations[1]!.dataPayloads).toEqual([Uint8Array.of(1, 2, 3, 4)]);
  });
  it('refuses ambiguous repeated programs but accepts a complete ordered mapping', () => {
    const instructions = [ix(A), ix(A, 1)];
    expect(mapInvocationContext(input(instructions, [open(A), close(A)])).status).toBe('unresolved');
    expect(mapInvocationContext(input(instructions, [open(A), close(A), open(A), close(A)])).status).toBe('mapped');
  });
  it('uses inner depth and rejects a hidden parent that contradicts apparent linear matches', () => {
    const logs = [open(A), open(B, 2), open(C, 3), close(C), close(B), close(A)];
    expect(mapInvocationContext(input([ix(A), ix(B, 0, 0, 2), ix(C, 0, 1, 3)], logs)).status).toBe('mapped');
    for (const depth of [2, null]) {
      const result = mapInvocationContext(input([ix(A), ix(B, 0, 0, 2), ix(A, 0, 1, depth), ix(C, 0, 2, 3)], logs));
      expect(result.status).toBe('unresolved');
      expect(result.invocations).toEqual([]);
    }
    expect(mapInvocationContext(input([ix(A), ix(B, 0, 0, 3)], [open(A), open(B, 2), close(B), close(A)])).status).toBe('unresolved');
  });
  it('propagates caught ancestor failure, failed transaction and unknown execution', () => {
    const logs = [open(A), open(B, 2), open(C, 3), close(C), `Program ${B} failed: custom program error: 1`, close(A)];
    const base = input([ix(A), ix(B, 0, 0, 2), ix(C, 0, 1, 3)], logs);
    expect(mapInvocationContext(base).invocations.map(i => i.applied)).toEqual([true, false, false]);
    expect(mapInvocationContext({ ...base, execution: 'failed' }).invocations.map(i => i.applied)).toEqual([false, false, false]);
    expect(mapInvocationContext({ ...base, execution: 'unknown' }).invocations.map(i => i.applied)).toEqual([null, false, false]);
  });
  it('keeps incomplete, malformed and discontinuous traces unresolved', () => {
    for (const logs of [[open(A)], [open(A), 'Log truncated', close(A)], [open(A), 'Log truncated (provider marker)', close(A)], [open(A), close(B)], [close(A)],
      [open(A), open(B, 3), close(B), close(A)], [open(A), 'Program data: @@@', close(A)], ['Program data: AQI=']]) {
      const result = mapInvocationContext(input([ix(A), ix(B, 0, 0, 3)], logs));
      expect(result.status).toBe('unresolved');
      expect(result.invocations).toEqual([]);
    }
  });
  it('does not treat user program-log messages as runtime invocation boundaries', () => {
    expect(mapInvocationContext(input([ix(A)], [open(A), `Program log: Program ${B} invoke [2]`, close(A)])).invocations).toHaveLength(1);
  });
  it('leaves unsupported trace lines unresolved rather than assuming they cannot affect scope', () => {
    for (const line of ['unsupported provider message', `Program ${B}\tinvoke [2]`, `Program ${B} completed`,
      'Program data: ', 'Program return: malformed', 'Program consumption: unavailable']) {
      const result = mapInvocationContext(input([ix(A)], [open(A), line, close(A)]));
      expect(result.status).toBe('unresolved');
      expect(result.invocations).toEqual([]);
    }
  });
  it('requires logs and inner recording, and does not invent scopes for empty traces', () => {
    const base = input([ix(A)], [open(A), close(A)]);
    for (const value of [{ ...base, logMessages: null }, { ...base, innerInstructionsRecorded: false }, { ...base, logMessages: [] }])
      expect(mapInvocationContext(value).status).toBe('unresolved');
  });
  it('refuses duplicate or invalid instruction coordinates and orphaned inner groups', () => {
    const logs = [open(A), close(A)];
    for (const instructions of [[ix(A), ix(A)], [ix(A, -1)], [ix(A, 0.5)], [ix(A, 0, -1)], [ix(A, 0, null, 2)],
      [ix(A, 1)], [ix(A), ix(B, 0, 1, 2)], [ix(A), ix(B, 1, 0, 2)], [ix(A), ix(B, 0, 0, 1)]])
      expect(mapInvocationContext(input(instructions, logs)).status).toBe('unresolved');
  });
  it('refuses invalid execution/log values supplied by untyped callers', () => {
    const base = input([ix(A)], [open(A), close(A)]);
    expect(mapInvocationContext({ ...base, execution: 'maybe' as InvocationContextInput['execution'] }).status).toBe('unresolved');
    expect(mapInvocationContext({ ...base, logMessages: [null as unknown as string] }).status).toBe('unresolved');
  });
});
