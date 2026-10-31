import { parseLogs, type ProgramLogChunk } from './parse-logs';

/** Coordinates in a complete RPC instruction list, including unlogged built-ins. */
export interface InvocationInstruction {
  programId: string;
  outerIndex: number;
  innerIndex: number | null;
  stackHeight: number | null;
}

export interface InvocationContextInput {
  instructions: readonly InvocationInstruction[];
  logMessages: readonly string[] | null;
  innerInstructionsRecorded: boolean;
  execution: 'succeeded' | 'failed' | 'unknown';
}

export interface BoundInvocation extends InvocationInstruction {
  traceIndex: number;
  parentTraceIndex: number | null;
  /** Retained log-root ordinal, which can differ from outerIndex. */
  rootOrdinal: number;
  depth: number;
  succeeded: boolean;
  /** A locally successful invocation is rolled back with any failed ancestor. */
  applied: boolean | null;
  dataPayloads: Uint8Array[];
}

export interface InvocationContext {
  status: 'mapped' | 'unresolved';
  invocations: BoundInvocation[];
  untracedInstructions: InvocationInstruction[];
  reasons: string[];
}

interface Frame {
  chunk: ProgramLogChunk;
  traceIndex: number;
  parentTraceIndex: number | null;
  rootOrdinal: number;
}

/** A monotone match is unique only when earliest and latest placements agree. */
function align<T, U>(observed: T[], instructions: U[], compatible: (a: T, b: U) => boolean): number[] | null {
  const earliest: number[] = [], latest = new Array<number>(observed.length);
  let cursor = 0;
  for (const item of observed) {
    while (cursor < instructions.length && !compatible(item, instructions[cursor]!)) cursor++;
    if (cursor === instructions.length) return null;
    earliest.push(cursor++);
  }
  cursor = instructions.length - 1;
  for (let i = observed.length - 1; i >= 0; i--) {
    while (cursor >= 0 && !compatible(observed[i]!, instructions[cursor]!)) cursor--;
    if (cursor < 0) return null;
    latest[i] = cursor--;
  }
  return earliest.every((position, i) => position === latest[i]) ? earliest : null;
}

/**
 * Bind a complete retained runtime trace to RPC instruction coordinates. This
 * proves invocation identity/outcome, not event decoding, swap semantics or
 * owner identity. Truncated traces stay unresolved; transaction success alone
 * cannot prove an inner invocation committed when its error could be caught.
 */
export function mapInvocationContext(input: InvocationContextInput): InvocationContext {
  const unresolved = (reason: string): InvocationContext => ({ status: 'unresolved', invocations: [],
    untracedInstructions: [...input.instructions], reasons: [reason] });
  if (!input.logMessages || !input.innerInstructionsRecorded)
    return unresolved('Invocation logs or inner instruction recording unavailable.');
  if (!['succeeded', 'failed', 'unknown'].includes(input.execution) || input.logMessages.some(line => typeof line !== 'string'))
    return unresolved('Invalid execution status or log input.');
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const identities = new Set<string>();
  for (const instruction of input.instructions) {
    const { outerIndex, innerIndex, stackHeight, programId } = instruction;
    const identity = JSON.stringify([outerIndex, innerIndex]);
    if (!integer(outerIndex) || innerIndex !== null && !integer(innerIndex)
      || typeof programId !== 'string' || !programId
      || stackHeight !== null && (!integer(stackHeight) || stackHeight < (innerIndex === null ? 1 : 2)
        || innerIndex === null && stackHeight !== 1) || identities.has(identity))
      return unresolved('Invalid or duplicate RPC instruction coordinates.');
    identities.add(identity);
  }
  const outer = input.instructions.filter(i => i.innerIndex === null).sort((a, b) => a.outerIndex - b.outerIndex);
  if (outer.some((i, n) => i.outerIndex !== n)
    || input.instructions.some(i => i.innerIndex !== null && !identities.has(JSON.stringify([i.outerIndex, null]))))
    return unresolved('RPC instruction list is incomplete or has orphaned inner groups.');
  for (const root of outer) {
    const inner = input.instructions.filter(i => i.outerIndex === root.outerIndex && i.innerIndex !== null).sort((a, b) => a.innerIndex! - b.innerIndex!);
    if (inner.some((i, n) => i.innerIndex !== n)) return unresolved('RPC inner instruction list is incomplete.');
  }
  const parsed = parseLogs([...input.logMessages]);
  // Recognized Program log: messages are free-form. Unsupported runtime lines
  // cannot be silently omitted when proving a complete invocation trace.
  if (parsed.logTruncated || input.logMessages.some(line => /^Log truncated\b/i.test(line))
    || parsed.parseErrors.length > 0)
    return unresolved('Invocation trace is truncated or structurally invalid.');
  const frames: Frame[] = [];
  let invalid = false;
  const visit = (chunk: ProgramLogChunk, parent: Frame | null, rootOrdinal: number) => {
    const frame: Frame = { chunk, traceIndex: frames.length, parentTraceIndex: parent?.traceIndex ?? null, rootOrdinal };
    frames.push(frame);
    if (chunk.depth !== (parent ? parent.chunk.depth + 1 : 1) || chunk.failureReason === 'truncated') invalid = true;
    chunk.children.forEach(child => visit(child, frame, rootOrdinal));
  };
  parsed.chunks.forEach((chunk, rootOrdinal) => visit(chunk, null, rootOrdinal));
  if (invalid || !frames.length) return unresolved('Invocation trace is empty, unfinished or has discontinuous depth.');
  const roots = frames.filter(f => f.parentTraceIndex === null);
  const rootMapping = align(roots, outer, (a, b) => a.chunk.programId === b.programId);
  if (!rootMapping) return unresolved('Log roots have no unique ordered RPC mapping.');
  const mapped = new Map<number, InvocationInstruction>();
  roots.forEach((root, n) => mapped.set(root.traceIndex, outer[rootMapping[n]!]!));
  for (const root of roots) {
    const nested = frames.filter(f => f.rootOrdinal === root.rootOrdinal && f.parentTraceIndex !== null);
    const inner = input.instructions.filter(i => i.outerIndex === mapped.get(root.traceIndex)!.outerIndex && i.innerIndex !== null)
      .sort((a, b) => a.innerIndex! - b.innerIndex!);
    const positions = align(nested, inner, (a, b) => a.chunk.programId === b.programId
      && (b.stackHeight === null || b.stackHeight === a.chunk.depth));
    if (!positions) return unresolved('Nested invocations have no unique ordered RPC mapping.');
    nested.forEach((frame, n) => mapped.set(frame.traceIndex, inner[positions[n]!]!));
    const frameByInstruction = new Map(nested.map(frame => [mapped.get(frame.traceIndex)!, frame]));
    const parents = new Map<number, InvocationInstruction>([[1, mapped.get(root.traceIndex)!]]);
    for (const instruction of inner) {
      const frame = frameByInstruction.get(instruction);
      const depth = instruction.stackHeight ?? frame?.chunk.depth ?? null;
      if (depth === null) { for (const level of parents.keys()) if (level > 1) parents.delete(level); continue; }
      if (frame && parents.get(depth - 1) !== mapped.get(frame.parentTraceIndex!))
        return unresolved('RPC and log invocation parents disagree or are unproven.');
      for (const level of parents.keys()) if (level >= depth) parents.delete(level);
      parents.set(depth, instruction);
    }
  }
  const invocations = frames.map(frame => {
    let rolledBack = !frame.chunk.success;
    let ancestor = frame.parentTraceIndex;
    while (ancestor !== null) { rolledBack ||= !frames[ancestor]!.chunk.success; ancestor = frames[ancestor]!.parentTraceIndex; }
    return { ...mapped.get(frame.traceIndex)!, traceIndex: frame.traceIndex, parentTraceIndex: frame.parentTraceIndex,
      rootOrdinal: frame.rootOrdinal, depth: frame.chunk.depth, succeeded: frame.chunk.success,
      applied: input.execution === 'failed' || rolledBack ? false : input.execution === 'succeeded' ? true : null,
      dataPayloads: frame.chunk.dataPayloads.map(data => data.slice()) };
  });
  const used = new Set(mapped.values());
  return { status: 'mapped', invocations, untracedInstructions: input.instructions.filter(i => !used.has(i)), reasons: [] };
}
