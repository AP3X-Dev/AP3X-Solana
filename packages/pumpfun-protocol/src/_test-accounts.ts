// Test helpers: encode pump.fun / PumpSwap accounts from the IDL layouts, so
// state-reader tests exercise the real byte layout rather than hand offsets.
import { PublicKey } from '@ap3x/solana-core';
import { camelCase, encodeIdlFields, PUMP_AMM_SCHEMA, PUMP_SCHEMA } from '@ap3x/pumpfun-events';
import type { IdlField, IdlProgramSchema, IdlType } from '@ap3x/pumpfun-events';

export const key = (n: number) => PublicKey.fromBytes(new Uint8Array(32).fill(n));

function defaultFor(type: IdlType): unknown {
  if (typeof type === 'string') {
    if (/^[ui](8|16|32)$/.test(type)) return 0;
    if (/^[ui](64|128)$/.test(type)) return 0n;
    if (type === 'bool') return false;
    if (type === 'pubkey') return key(0);
    if (type === 'string') return '';
    return new Uint8Array();
  }
  if ('vec' in type) return [];
  if ('option' in type) return null;
  if ('array' in type) return Array.from({ length: type.array[1] }, () => defaultFor(type.array[0]));
  return undefined;
}

/**
 * `[discriminator || borsh]` for an IDL account. Unset fields get zero values;
 * `fieldCount` truncates to an older, shorter layout.
 */
export function encodeAccount(
  schema: IdlProgramSchema,
  name: string,
  values: Record<string, unknown>,
  fieldCount?: number,
): Uint8Array {
  const layout = schema.accounts.find((a) => a.name === name);
  if (!layout) throw new Error(`no account ${name}`);
  const fields: IdlField[] = layout.fields.slice(0, fieldCount ?? layout.fields.length);
  const full: Record<string, unknown> = {};
  for (const f of fields) full[camelCase(f.name)] = values[camelCase(f.name)] ?? defaultFor(f.type);
  const disc = layout.discriminator.match(/../g)!.map((h) => parseInt(h, 16));
  return new Uint8Array([...disc, ...encodeIdlFields(fields, full, schema.types)]);
}

export const bondingCurveBytes = (v: Record<string, unknown>, fieldCount?: number) =>
  encodeAccount(PUMP_SCHEMA, 'BondingCurve', v, fieldCount);
export const globalBytes = (v: Record<string, unknown>) => encodeAccount(PUMP_SCHEMA, 'Global', v);
export const poolBytes = (v: Record<string, unknown>) => encodeAccount(PUMP_AMM_SCHEMA, 'Pool', v);
export const globalConfigBytes = (v: Record<string, unknown>) => encodeAccount(PUMP_AMM_SCHEMA, 'GlobalConfig', v);

/** SPL token account bytes with `amount` at offset 64. */
export function tokenAccountBytes(amount: bigint): Uint8Array {
  const b = new Uint8Array(165);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  return b;
}

/** `getAccountInfo` response shape for a mocked RpcPool. */
export const accountInfo = (bytes: Uint8Array) => ({
  value: { data: [Buffer.from(bytes).toString('base64'), 'base64'] },
});
