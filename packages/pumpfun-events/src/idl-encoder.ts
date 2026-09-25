import type { PublicKey } from '@ap3x/solana-core';
import { camelCase } from './idl-decoder.js';
import type { IdlField, IdlType, IdlTypeDef } from './idl-types.js';

/** Borsh encoder mirroring {@link decodeIdlEvent}'s decoder, driven by IDL types. */

const INT: Record<string, number> = {
  u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16,
};

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
    if (size) return le(BigInt(v as number | bigint), size);
    if (type === 'bool') return [v ? 1 : 0];
    if (type === 'pubkey') return [...(v as PublicKey).toBuffer()];
    if (type === 'string') {
      const b = [...new TextEncoder().encode(v as string)];
      return [...le(BigInt(b.length), 4), ...b];
    }
    if (type === 'bytes') return [...le(BigInt((v as Uint8Array).length), 4), ...(v as Uint8Array)];
    throw new Error(`unsupported idl type ${type}`);
  }
  if ('vec' in type) {
    const arr = v as unknown[];
    return [...le(BigInt(arr.length), 4), ...arr.flatMap((x) => encodeIdlValue(type.vec, x, types))];
  }
  if ('option' in type) return v === null || v === undefined ? [0] : [1, ...encodeIdlValue(type.option, v, types)];
  if ('array' in type) return (v as unknown[]).flatMap((x) => encodeIdlValue(type.array[0], x, types));
  const def = types[type.defined.name];
  if (!def) throw new Error(`idl type ${type.defined.name} not in schema`);
  if (def.kind === 'struct') return encodeFieldList(def.fields, v, types);
  const name = typeof v === 'string' ? v : (v as { variant: string }).variant;
  const idx = def.variants.findIndex((x) => x.name === name);
  const variant = def.variants[idx];
  if (!variant) throw new Error(`enum ${type.defined.name} has no variant ${name}`);
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
    const obj = v as Record<string, unknown>;
    return (fields as IdlField[]).flatMap((f) => encodeIdlValue(f.type, obj[camelCase(f.name)], types));
  }
  const arr = v as unknown[];
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
