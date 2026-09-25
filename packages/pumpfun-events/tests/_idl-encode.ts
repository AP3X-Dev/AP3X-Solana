// Test helpers: sample values for every IDL type and event encoding, so
// events can be round-tripped without hand-built bytes.
import { PublicKey } from '@ap3x/solana-core';
import type { IdlField, IdlProgramSchema, IdlType, IdlTypeDef } from '../src/idl-types.js';
import { camelCase } from '../src/idl-decoder.js';
import { encodeIdlFields } from '../src/idl-encoder.js';

let seq = 1;
export function sampleValue(type: IdlType, types: Record<string, IdlTypeDef>): unknown {
  if (typeof type === 'string') {
    if (/^[ui](8|16|32)$/.test(type)) return seq++ % 120;
    if (/^[ui](64|128)$/.test(type)) return BigInt(seq++) * 1_000_003n;
    if (type === 'bool') return seq++ % 2 === 0;
    if (type === 'pubkey') return PublicKey.fromBytes(new Uint8Array(32).fill(seq++ % 250));
    if (type === 'string') return `s${seq++}`;
    if (type === 'bytes') return new Uint8Array([seq++ % 250]);
    throw new Error(type);
  }
  if ('vec' in type) return [sampleValue(type.vec, types)];
  if ('option' in type) return sampleValue(type.option, types);
  if ('array' in type) return Array.from({ length: type.array[1] }, () => sampleValue(type.array[0], types));
  const def = types[type.defined.name]!;
  if (def.kind === 'struct') return sampleFields(def.fields as IdlField[] | undefined, types);
  const v = def.variants[0]!;
  return v.fields ? { variant: v.name, fields: sampleFields(v.fields as IdlField[], types) } : v.name;
}

function sampleFields(fields: IdlField[] | undefined, types: Record<string, IdlTypeDef>) {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) out[camelCase(f.name)] = sampleValue(f.type, types);
  return out;
}

/** Encode `[disc || fields]` for an event; `fieldCount` truncates to an older layout. */
export function encodeEvent(
  schema: IdlProgramSchema,
  eventName: string,
  values?: Record<string, unknown>,
  fieldCount?: number,
): { bytes: Uint8Array; values: Record<string, unknown> } {
  const ev = schema.events.find((e) => e.name === eventName);
  if (!ev) throw new Error(`no event ${eventName}`);
  const fields = ev.fields.slice(0, fieldCount ?? ev.fields.length);
  const vals = values ?? sampleFields(fields, schema.types);
  const disc = ev.discriminator.match(/../g)!.map((h) => parseInt(h, 16));
  return { bytes: new Uint8Array([...disc, ...encodeIdlFields(fields, vals, schema.types)]), values: vals };
}
