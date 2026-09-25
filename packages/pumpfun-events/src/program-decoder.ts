import type { PublicKey } from '@ap3x/solana-core';
import type { ProgramDecoder, ProgramLogChunk, UnknownEventDecode } from '@ap3x/solana-events';
import { toHex } from './hex.js';
import { decodeIdlEvent, eventKindSuffix } from './idl-decoder.js';
import type { IdlProgramSchema } from './idl-types.js';

/**
 * Build a decoder for one program. Events named in `typed` become
 * `{ kind: '<prefix>.<suffix>', ...fields }` records and must carry their
 * listed required fields; every other IDL event becomes a
 * `{ kind: '<prefix>.other', eventName, fields }` record.
 */
export function makeIdlDecoder<TEvent>(opts: {
  programId: PublicKey;
  schema: IdlProgramSchema;
  prefix: 'pumpfun' | 'pumpswap';
  typed: Record<string, readonly string[]>;
}): ProgramDecoder<TEvent> & Required<Pick<ProgramDecoder<TEvent>, 'decodeAll'>> {
  const { programId, schema, prefix, typed } = opts;
  const unknown = (reason: string): UnknownEventDecode => ({
    kind: 'unknown',
    programId: programId.toBase58(),
    reason,
  });

  /** Decode one payload; `undefined` when its discriminator is not an IDL event. */
  const decodePayload = (data: Uint8Array): TEvent | UnknownEventDecode | undefined => {
    let decoded;
    try {
      decoded = decodeIdlEvent(schema, data);
    } catch (err) {
      return unknown(`borsh-parse-error:${(err as Error).message}`);
    }
    if (!decoded) return undefined;
    const suffix = eventKindSuffix(decoded.name);
    const required = typed[suffix];
    if (!required) {
      return { kind: `${prefix}.other`, eventName: decoded.name, fields: decoded.fields } as TEvent;
    }
    const missing = required.filter((f) => !(f in decoded.fields));
    if (missing.length > 0) return unknown(`incomplete:${decoded.name}:${missing.join(',')}`);
    return { kind: `${prefix}.${suffix}`, ...decoded.fields } as TEvent;
  };

  const unrecognised = (data: Uint8Array | undefined): UnknownEventDecode =>
    !data
      ? unknown('no-data-payload')
      : unknown(data.length < 8 ? 'truncated-data' : `unknown-discriminator:${toHex(data.subarray(0, 8))}`);

  return {
    programId,
    // Events arrive as `Program data:` lines (Anchor emit!), already
    // base64-decoded by parseLogs.
    decode(chunk: ProgramLogChunk): TEvent | UnknownEventDecode {
      for (const data of chunk.dataPayloads) {
        const r = decodePayload(data);
        if (r) return r;
      }
      return unrecognised(chunk.dataPayloads[0]);
    },
    /** Every payload in the invocation — one instruction can emit several events. */
    decodeAll(chunk: ProgramLogChunk): Array<TEvent | UnknownEventDecode> {
      if (chunk.dataPayloads.length === 0) return [unrecognised(undefined)];
      return chunk.dataPayloads.map((d) => decodePayload(d) ?? unrecognised(d));
    },
  };
}
