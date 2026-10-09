import { PublicKey } from '@ap3x/solana-core';
import { toHex } from './hex.js';
import type { IdlField, IdlProgramSchema, IdlType, IdlTypeDef } from './idl-types.js';

/**
 * Borsh decoder driven by an Anchor IDL schema. Field layouts and
 * discriminators come from the program's published IDL, so nothing here is
 * hand-maintained per event.
 */

export interface DecodedIdlEvent {
  /** IDL event name, e.g. `TradeEvent`. */
  name: string;
  /** Decoded fields, camelCased. */
  fields: Record<string, unknown>;
  /**
   * False when the payload ended before the last IDL field. Programs append
   * fields over time, so older transactions carry a prefix of today's layout;
   * the missing trailing fields are simply absent from `fields`.
   */
  complete: boolean;
}

class Cursor {
  offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  take(n: number): Uint8Array {
    if (this.offset + n > this.buf.length) throw new RangeError('eof');
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  get done(): boolean {
    return this.offset >= this.buf.length;
  }
}

function uintLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] ?? 0);
  return v;
}

function intLE(bytes: Uint8Array): bigint {
  const u = uintLE(bytes);
  const bits = BigInt(bytes.length * 8);
  return u >= 1n << (bits - 1n) ? u - (1n << bits) : u;
}

export function camelCase(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const INT_SIZES: Record<string, [number, boolean]> = {
  u8: [1, false], i8: [1, true], u16: [2, false], i16: [2, true],
  u32: [4, false], i32: [4, true], u64: [8, false], i64: [8, true],
  u128: [16, false], i128: [16, true],
};

function decodeValue(c: Cursor, type: IdlType, types: Record<string, IdlTypeDef>): unknown {
  if (typeof type === 'string') {
    const int = INT_SIZES[type];
    if (int) {
      const [size, signed] = int;
      const bytes = c.take(size);
      const v = signed ? intLE(bytes) : uintLE(bytes);
      return size <= 4 ? Number(v) : v;
    }
    switch (type) {
      case 'bool':
        return c.take(1)[0] !== 0;
      case 'pubkey':
        return PublicKey.fromBytes(c.take(32));
      case 'string':
        return new TextDecoder().decode(c.take(Number(uintLE(c.take(4)))));
      case 'bytes':
        return c.take(Number(uintLE(c.take(4)))).slice();
      default:
        throw new Error(`unsupported idl type ${type}`);
    }
  }
  if ('vec' in type) {
    const n = Number(uintLE(c.take(4)));
    return Array.from({ length: n }, () => decodeValue(c, type.vec, types));
  }
  if ('option' in type) {
    return c.take(1)[0] === 0 ? null : decodeValue(c, type.option, types);
  }
  if ('array' in type) {
    const [inner, n] = type.array;
    return Array.from({ length: n }, () => decodeValue(c, inner, types));
  }
  const def = types[type.defined.name];
  if (!def) throw new Error(`idl type ${type.defined.name} not in schema`);
  return decodeDefined(c, def, types);
}

function decodeFieldList(
  c: Cursor,
  fields: IdlField[] | IdlType[] | undefined,
  types: Record<string, IdlTypeDef>,
): unknown {
  if (!fields || fields.length === 0) return {};
  if (typeof fields[0] === 'object' && fields[0] !== null && 'name' in fields[0] && 'type' in fields[0]) {
    const out: Record<string, unknown> = {};
    for (const f of fields as IdlField[]) out[camelCase(f.name)] = decodeValue(c, f.type, types);
    return out;
  }
  return (fields as IdlType[]).map((t) => decodeValue(c, t, types));
}

function decodeDefined(c: Cursor, def: IdlTypeDef, types: Record<string, IdlTypeDef>): unknown {
  if (def.kind === 'struct') return decodeFieldList(c, def.fields, types);
  const idx = c.take(1)[0] ?? 0;
  const variant = def.variants[idx];
  if (!variant) throw new Error(`enum variant ${idx} out of range`);
  return variant.fields ? { variant: variant.name, fields: decodeFieldList(c, variant.fields, types) } : variant.name;
}

/** Decode `[discriminator(8) || borsh payload]` against a program schema. */
export function decodeIdlEvent(schema: IdlProgramSchema, data: Uint8Array): DecodedIdlEvent | undefined {
  if (data.length < 8) return undefined;
  const disc = toHex(data.subarray(0, 8));
  const event = schema.events.find((e) => e.discriminator === disc);
  if (!event) return undefined;
  const c = new Cursor(data.subarray(8));
  const fields: Record<string, unknown> = {};
  for (const f of event.fields) {
    if (c.done) return { name: event.name, fields, complete: false };
    // Running out mid-field (RangeError) means a malformed payload, not an
    // older layout; it propagates to the caller.
    fields[camelCase(f.name)] = decodeValue(c, f.type, schema.types);
  }
  return { name: event.name, fields, complete: true };
}

/**
 * Decode an Anchor account (`[discriminator(8) || borsh]`) by IDL account
 * name. Throws when the discriminator doesn't match or the data is shorter
 * than the layout; trailing bytes (padding, newer fields) are ignored.
 */
export function decodeIdlAccount(
  schema: IdlProgramSchema,
  accountName: string,
  data: Uint8Array,
  options: { layoutVersion?: string } = {},
): Record<string, unknown> {
  const layout = schema.accounts.find((a) => a.name === accountName);
  if (!layout) throw new Error(`account ${accountName} not in schema`);
  if (toHex(data.subarray(0, 8)) !== layout.discriminator) {
    throw new Error(`${accountName}: discriminator mismatch`);
  }
  const c = new Cursor(data.subarray(8));
  const fields: Record<string, unknown> = {};
  if (options.layoutVersion && (layout.legacyFields || layout.previousFieldCount !== undefined)
    && options.layoutVersion !== 'e0687ae9' && options.layoutVersion !== '2293f9a6') {
    throw new Error(`${accountName}: unknown layout version`);
  }
  const paddedAmbiguity = !options.layoutVersion && layout.legacyPaddedSizes?.includes(data.length);
  const olderPrefix = layout.previousFieldCount !== undefined
    && (options.layoutVersion === layout.previousVersion || paddedAmbiguity);
  const selected = layout.legacyFields && options.layoutVersion !== layout.nonAppendVersion
    ? layout.legacyFields : olderPrefix ? layout.fields.slice(0, layout.previousFieldCount) : layout.fields;
  for (const f of selected) {
    // Only a clean field boundary is an older prefix. Mid-field truncation stays malformed.
    if (c.done) break;
    fields[camelCase(f.name)] = decodeValue(c, f.type, schema.types);
  }
  if (layout.legacyFields && !options.layoutVersion) {
    // admin and mints retain their exact offsets. Reserved bytes cannot establish a new administrator.
    const common = new Set(layout.fields.filter(field => field.name !== '_reserved')
      .map(field => camelCase(field.name)));
    for (const name of Object.keys(fields)) if (!common.has(name)) delete fields[name];
    fields['layoutVersion'] = 'unknown';
  }
  if (paddedAmbiguity) fields['layoutVersion'] = 'unknown';
  return fields;
}

/** `TradeEvent` → `trade`, `CompletePumpAmmMigrationEvent` → `complete_pump_amm_migration`. */
export function eventKindSuffix(eventName: string): string {
  return eventName
    .replace(/Event$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}
