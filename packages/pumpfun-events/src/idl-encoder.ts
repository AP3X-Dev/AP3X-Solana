import type { PublicKey } from '@ap3x/solana-core';
import { camelCase } from './idl-decoder.js';
import type { IdlField, IdlType, IdlTypeDef } from './idl-types.js';

/** Borsh encoder mirroring {@link decodeIdlEvent}'s decoder, driven by IDL types. */

const INT: Record<string, number> = {
  u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16,
};

function integerValue(type: string, value: unknown, size: number): bigint {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))
    && !(typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)))
    throw new TypeError(`${type} requires an exact integer`);
  const v = BigInt(value as bigint | number | string);
  const signed = type.startsWith('i');
  const bits = BigInt(size * 8 - (signed ? 1 : 0));
  const min = signed ? -(1n << bits) : 0n;
  const max = (1n << bits) - 1n;
  if (v < min || v > max) throw new RangeError(`${type} integer out of range`);
  return v;
}

function le(v: bigint, size: number): number[] {
  const mod = 1n << BigInt(size * 8);
  let x = ((v % mod) + mod) % mod;
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

export function encodeIdlValue(type: IdlType, v: unknown, types: Record<string, IdlTypeDef>): number[] {
  if (typeof type === 'string') {
    const size = INT[type];
    if (size) return le(integerValue(type, v, size), size);
    if (type === 'bool') {
      if (typeof v !== 'boolean') throw new TypeError('bool requires a boolean');
      return [v ? 1 : 0];
    }
    if (type === 'pubkey') {
      if (!v || typeof (v as PublicKey).toBuffer !== 'function') throw new TypeError('pubkey requires a public key');
      const bytes = (v as PublicKey).toBuffer();
      if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new TypeError('pubkey requires 32 bytes');
      return [...bytes];
    }
    if (type === 'string') {
      if (typeof v !== 'string') throw new TypeError('string requires a string');
      const b = new TextEncoder().encode(v);
      if (new TextDecoder('utf-8', { fatal: true }).decode(b) !== v) throw new TypeError('string contains an unpaired surrogate');
      return [...le(BigInt(b.length), 4), ...b];
    }
    if (type === 'bytes') {
      if (!(v instanceof Uint8Array)) throw new TypeError('bytes requires a Uint8Array');
      return [...le(BigInt(v.length), 4), ...v];
    }
    throw new Error(`unsupported idl type ${type}`);
  }
  if ('vec' in type) {
    if (!Array.isArray(v)) throw new TypeError('vec requires an array');
    const arr = v;
    return [...le(BigInt(arr.length), 4), ...arr.flatMap((x) => encodeIdlValue(type.vec, x, types))];
  }
  if ('option' in type) return v === null || v === undefined ? [0] : [1, ...encodeIdlValue(type.option, v, types)];
  if ('array' in type) {
    if (!Array.isArray(v) || v.length !== type.array[1]) throw new TypeError('fixed array length mismatch');
    return v.flatMap((x) => encodeIdlValue(type.array[0], x, types));
  }
  const def = types[type.defined.name];
  if (!def) throw new Error(`idl type ${type.defined.name} not in schema`);
  if (def.kind === 'struct') return encodeFieldList(def.fields, v, types);
  const name = typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { variant: string }).variant : undefined;
  const idx = def.variants.findIndex((x) => x.name === name);
  const variant = def.variants[idx];
  if (!variant) throw new Error(`enum ${type.defined.name} has no variant ${name}`);
  if (idx > 255) throw new RangeError('enum variant does not fit u8');
  return [idx, ...(variant.fields ? encodeFieldList(variant.fields, (v as { fields: unknown }).fields, types) : [])];
}

function encodeFieldList(
  fields: IdlField[] | IdlType[] | undefined,
  v: unknown,
  types: Record<string, IdlTypeDef>,
): number[] {
  if (!fields || fields.length === 0) return [];
  const first = fields[0];
  if (typeof first === 'object' && first !== null && 'name' in first && 'type' in first) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('named fields require an object');
    const obj = v as Record<string, unknown>;
    return (fields as IdlField[]).flatMap((f) => encodeIdlValue(f.type, obj[camelCase(f.name)], types));
  }
  if (!Array.isArray(v) || v.length !== fields.length) throw new TypeError('tuple field count mismatch');
  const arr = v;
  return (fields as IdlType[]).flatMap((t, i) => encodeIdlValue(t, arr[i], types));
}

/** Encode named fields (camelCase keys) in IDL order. */
export function encodeIdlFields(
  fields: IdlField[],
  values: Record<string, unknown>,
  types: Record<string, IdlTypeDef>,
): Uint8Array {
  return new Uint8Array(encodeFieldList(fields, values, types));
}
