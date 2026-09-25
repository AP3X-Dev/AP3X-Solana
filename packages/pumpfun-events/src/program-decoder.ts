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
}): ProgramDecoder<TEvent> {
  const { programId, schema, prefix, typed } = opts;
  const unknown = (reason: string): UnknownEventDecode => ({
    kind: 'unknown',
    programId: programId.toBase58(),
    reason,
  });

  return {
    programId,
    decode(chunk: ProgramLogChunk): TEvent | UnknownEventDecode {
      // Events arrive as `Program data:` lines (Anchor emit!), already
      // base64-decoded by parseLogs. Take the first payload the IDL knows.
      if (chunk.dataPayloads.length === 0) return unknown('no-data-payload');
      for (const data of chunk.dataPayloads) {
        let decoded;
        try {
          decoded = decodeIdlEvent(schema, data);
        } catch (err) {
          return unknown(`borsh-parse-error:${(err as Error).message}`);
        }
        if (!decoded) continue;
        const suffix = eventKindSuffix(decoded.name);
        const required = typed[suffix];
        if (!required) {
          return { kind: `${prefix}.other`, eventName: decoded.name, fields: decoded.fields } as TEvent;
        }
        const missing = required.filter((f) => !(f in decoded.fields));
        if (missing.length > 0) return unknown(`incomplete:${decoded.name}:${missing.join(',')}`);
        return { kind: `${prefix}.${suffix}`, ...decoded.fields } as TEvent;
      }
      const first = chunk.dataPayloads[0] ?? new Uint8Array();
      return unknown(
        first.length < 8 ? 'truncated-data' : `unknown-discriminator:${toHex(first.subarray(0, 8))}`,
      );
    },
  };
}
