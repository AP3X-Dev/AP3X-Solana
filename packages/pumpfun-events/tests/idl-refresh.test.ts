import { describe, expect, it } from 'vitest';
import { PUMP_SCHEMA, PUMP_AMM_SCHEMA, decodeIdlAccount, decodeIdlEvent, encodeIdlFields, camelCase } from '../src/index.js';
import type { IdlField, IdlProgramSchema } from '../src/idl-types.js';
import { encodeEvent, sampleValue } from './_idl-encode.js';

function account(schema: IdlProgramSchema, name: string, count?: number, legacy = false) {
  const layout = schema.accounts.find(item => item.name === name)!;
  const fields = (legacy ? layout.legacyFields! : layout.fields).slice(0, count);
  const values = Object.fromEntries(fields.map(field => [camelCase(field.name), sampleValue(field.type, schema.types)]));
  const discriminator = Uint8Array.from(Buffer.from(layout.discriminator, 'hex'));
  return { values, bytes: new Uint8Array([...discriminator, ...encodeIdlFields(fields, values, schema.types)]) };
}

describe('pump public IDL 2293f9a6', () => {
  for (const [schema, names] of [[PUMP_SCHEMA, ['PostCompleteBuyEvent', 'SetQuoteControlMintReservesEvent',
    'SetQuoteControlReservesAdminEvent', 'SweepBondingCurveFeeEvent']], [PUMP_AMM_SCHEMA, ['SweepPoolFeeEvent']]] as const) {
    for (const name of names) it(`decodes ${name} with every published field`, () => {
      const fixture = encodeEvent(schema, name);
      expect(decodeIdlEvent(schema, fixture.bytes)).toEqual({ name, fields: fixture.values, complete: true });
    });
  }

  for (const [schema, name, oldCount] of [[PUMP_SCHEMA, 'BondingCurve', 13], [PUMP_SCHEMA, 'Global', 29],
    [PUMP_AMM_SCHEMA, 'Pool', 16]] as const) {
    it(`preserves ${name} prefixes and refuses a malformed appended field`, () => {
      const old = account(schema, name, oldCount), current = account(schema, name);
      expect(decodeIdlAccount(schema, name, old.bytes)).toEqual(old.values);
      expect(decodeIdlAccount(schema, name, current.bytes)).toEqual(current.values);
      const firstAdded = schema.accounts.find(item => item.name === name)!.fields[oldCount]!;
      const encoded = encodeIdlFields([firstAdded], { [camelCase(firstAdded.name)]: current.values[camelCase(firstAdded.name)] }, schema.types);
      if (encoded.length > 1) expect(() => decodeIdlAccount(schema, name,
        new Uint8Array([...old.bytes, ...encoded.slice(0, -1)]))).toThrow(/eof/);
    });
  }

  it('never interprets same-length legacy reserved bytes as a known QuoteControl administrator', () => {
    const legacy = account(PUMP_SCHEMA, 'QuoteControl', undefined, true);
    const current = account(PUMP_SCHEMA, 'QuoteControl');
    expect(legacy.bytes.length).toBe(current.bytes.length);
    for (const fixture of [legacy, current]) {
      const ambiguous = decodeIdlAccount(PUMP_SCHEMA, 'QuoteControl', fixture.bytes);
      expect(ambiguous['admin']).toEqual(fixture.values['admin']);
      expect(ambiguous['mints']).toEqual(fixture.values['mints']);
      expect(ambiguous['reservesAdmin']).toBeUndefined();
      expect(ambiguous['layoutVersion']).toBe('unknown');
    }
    expect(decodeIdlAccount(PUMP_SCHEMA, 'QuoteControl', legacy.bytes, { layoutVersion: 'e0687ae9' })).toEqual(legacy.values);
    expect(decodeIdlAccount(PUMP_SCHEMA, 'QuoteControl', current.bytes, { layoutVersion: '2293f9a6' })).toEqual(current.values);
    expect(() => decodeIdlAccount(PUMP_SCHEMA, 'QuoteControl', current.bytes, { layoutVersion: 'guessed' })).toThrow(/unknown layout/);
  });

  it('does not turn retained curve and pool allocation padding into measured new fees', () => {
    for (const [schema, name, count, length, field] of [[PUMP_SCHEMA, 'BondingCurve', 13, 151, 'creatorFee'],
      [PUMP_AMM_SCHEMA, 'Pool', 16, 301, 'protocolFees']] as const) {
      const old = account(schema, name, count);
      const padded = new Uint8Array(length);
      padded.set(old.bytes);
      const decoded = decodeIdlAccount(schema, name, padded);
      expect(decoded).toEqual({ ...old.values, layoutVersion: 'unknown' });
      expect(decoded[field]).toBeUndefined();
      expect(decodeIdlAccount(schema, name, padded, { layoutVersion: 'e0687ae9' })).toEqual(old.values);
    }
  });

  for (const [schema, names] of [[PUMP_SCHEMA, ['buy_v3', 'sell_v3', 'buy_exact_quote_in_v3', 'multi_hop_curve_swap']],
    [PUMP_AMM_SCHEMA, ['buy_v2', 'sell_v2', 'buy_exact_quote_in_v2', 'multi_hop_swap']]] as const) {
    for (const name of names) it(`retains ${name} discriminator, account order and encodable arguments`, () => {
      const instruction = schema.instructions.find(item => item.name === name)!;
      expect(instruction).toBeDefined();
      expect(instruction.discriminator).toMatch(/^[0-9a-f]{16}$/);
      expect(instruction.accounts.length).toBeGreaterThan(0);
      const values = Object.fromEntries(instruction.args.map((field: IdlField) => [camelCase(field.name),
        typeof field.type === 'object' && 'defined' in field.type && field.type.defined.name === 'OptionBool'
          ? [true] : sampleValue(field.type, schema.types)]));
      expect(encodeIdlFields(instruction.args, values, schema.types).length).toBeGreaterThan(0);
    });
  }
});
