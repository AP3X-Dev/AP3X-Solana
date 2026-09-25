import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProgramLogChunk } from '@ap3x/solana-events';
import {
  bondingCurveDecoder,
  camelCase,
  decodeIdlAccount,
  encodeIdlFields,
  eventKindSuffix,
  PUMP_AMM_SCHEMA,
  PUMP_SCHEMA,
  pumpSwapDecoder,
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '../src/index.js';
import { encodeEvent, sampleValue } from './_idl-encode.js';

function chunk(dataPayloads: Uint8Array[], programId = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58()): ProgramLogChunk {
  return { programId, depth: 1, success: true, logs: [], dataPayloads, children: [], rawLines: [] };
}

const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

describe('vendored IDL schema', () => {
  it('uses the program addresses the decoders are registered for', () => {
    expect(PUMP_SCHEMA.address).toBe(PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58());
    expect(PUMP_AMM_SCHEMA.address).toBe(PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58());
  });

  it('every event discriminator is sha256("event:<Name>")[0..8]', () => {
    for (const s of [PUMP_SCHEMA, PUMP_AMM_SCHEMA]) {
      for (const e of s.events) expect(e.discriminator, e.name).toBe(sha8(`event:${e.name}`));
    }
  });

  it('every instruction discriminator is sha256("global:<name>")[0..8]', () => {
    for (const s of [PUMP_SCHEMA, PUMP_AMM_SCHEMA]) {
      for (const ix of s.instructions) expect(ix.discriminator, ix.name).toBe(sha8(`global:${ix.name}`));
    }
  });
});

const BONDING_TYPED = [
  'CreateEvent', 'TradeEvent', 'CompleteEvent', 'CompletePumpAmmMigrationEvent',
  'CollectCreatorFeeEvent', 'SetParamsEvent',
];
const PUMPSWAP_TYPED = ['BuyEvent', 'SellEvent', 'DepositEvent', 'WithdrawEvent', 'CreatePoolEvent'];

describe('bondingCurveDecoder', () => {
  for (const name of BONDING_TYPED) {
    it(`round-trips ${name} with every IDL field`, () => {
      const { bytes, values } = encodeEvent(PUMP_SCHEMA, name);
      const r = bondingCurveDecoder.decode(chunk([bytes]));
      expect(r.kind).toBe(`pumpfun.${eventKindSuffix(name)}`);
      expect(r).toEqual({ kind: r.kind, ...values });
    });
  }

  it('decodes an older TradeEvent layout that stops after the reserves', () => {
    const { bytes, values } = encodeEvent(PUMP_SCHEMA, 'TradeEvent', undefined, 10);
    const r = bondingCurveDecoder.decode(chunk([bytes]));
    expect(r.kind).toBe('pumpfun.trade');
    if (r.kind !== 'pumpfun.trade') return;
    expect(r.solAmount).toBe(values['solAmount']);
    expect(r.feeRecipient).toBeUndefined();
  });

  it('decodes the original 6-field CreateEvent layout', () => {
    const { bytes } = encodeEvent(PUMP_SCHEMA, 'CreateEvent', undefined, 6);
    expect(bondingCurveDecoder.decode(chunk([bytes])).kind).toBe('pumpfun.create');
  });

  it('rejects a layout missing a required field', () => {
    const { bytes } = encodeEvent(PUMP_SCHEMA, 'TradeEvent', undefined, 5);
    const r = bondingCurveDecoder.decode(chunk([bytes]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toMatch(/^incomplete:TradeEvent:timestamp/);
  });

  it('reports a payload that ends mid-field as a parse error', () => {
    const { bytes } = encodeEvent(PUMP_SCHEMA, 'TradeEvent');
    const r = bondingCurveDecoder.decode(chunk([bytes.subarray(0, 8 + 32 + 3)]));
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.reason).toMatch(/^borsh-parse-error:/);
  });

  it('decodes events without a typed record as pumpfun.other', () => {
    const { bytes, values } = encodeEvent(PUMP_SCHEMA, 'ExtendAccountEvent');
    expect(bondingCurveDecoder.decode(chunk([bytes]))).toEqual({
      kind: 'pumpfun.other',
      eventName: 'ExtendAccountEvent',
      fields: values,
    });
  });

  it('skips unrecognised payloads and decodes the first known one', () => {
    const { bytes } = encodeEvent(PUMP_SCHEMA, 'CompleteEvent');
    const junk = new Uint8Array(16).fill(0xff);
    expect(bondingCurveDecoder.decode(chunk([junk, bytes])).kind).toBe('pumpfun.complete');
  });

  it('returns typed unknown records and never throws on bad input', () => {
    const reasons = [
      [[], 'no-data-payload'],
      [[new Uint8Array([1, 2, 3])], 'truncated-data'],
      [[new Uint8Array(16).fill(0xff)], 'unknown-discriminator:ffffffffffffffff'],
    ] as const;
    for (const [payloads, reason] of reasons) {
      const r = bondingCurveDecoder.decode(chunk([...payloads]));
      expect(r).toMatchObject({ kind: 'unknown', reason });
    }
  });

  it('decodeAll returns every event in one invocation (final buy + completion)', () => {
    const trade = encodeEvent(PUMP_SCHEMA, 'TradeEvent').bytes;
    const complete = encodeEvent(PUMP_SCHEMA, 'CompleteEvent').bytes;
    const junk = new Uint8Array(16).fill(0xff);
    const all = bondingCurveDecoder.decodeAll(chunk([trade, junk, complete]));
    expect(all.map((e) => e.kind)).toEqual(['pumpfun.trade', 'unknown', 'pumpfun.complete']);
    // decode() still returns the first recognised event.
    expect(bondingCurveDecoder.decode(chunk([trade, complete])).kind).toBe('pumpfun.trade');
  });

  it('does not decode PumpSwap events', () => {
    const { bytes } = encodeEvent(PUMP_AMM_SCHEMA, 'BuyEvent');
    expect(bondingCurveDecoder.decode(chunk([bytes])).kind).toBe('unknown');
  });
});

describe('pumpSwapDecoder', () => {
  const ps = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();
  for (const name of PUMPSWAP_TYPED) {
    it(`round-trips ${name} with every IDL field`, () => {
      const { bytes, values } = encodeEvent(PUMP_AMM_SCHEMA, name);
      const r = pumpSwapDecoder.decode(chunk([bytes], ps));
      expect(r.kind).toBe(`pumpswap.${eventKindSuffix(name)}`);
      expect(r).toEqual({ kind: r.kind, ...values });
    });
  }

  it('decodes a pre-creator-fee BuyEvent layout', () => {
    // coin_creator and later fields were added after launch.
    const idx = PUMP_AMM_SCHEMA.events.find((e) => e.name === 'BuyEvent')!.fields.findIndex((f) => f.name === 'coin_creator');
    const { bytes } = encodeEvent(PUMP_AMM_SCHEMA, 'BuyEvent', undefined, idx);
    const r = pumpSwapDecoder.decode(chunk([bytes], ps));
    expect(r.kind).toBe('pumpswap.buy');
    if (r.kind === 'pumpswap.buy') expect(r.coinCreator).toBeUndefined();
  });

  it('decodes other IDL events as pumpswap.other', () => {
    const { bytes } = encodeEvent(PUMP_AMM_SCHEMA, 'CreateConfigEvent');
    expect(pumpSwapDecoder.decode(chunk([bytes], ps))).toMatchObject({
      kind: 'pumpswap.other',
      eventName: 'CreateConfigEvent',
    });
  });
});

describe('decodeIdlAccount', () => {
  const encodeAccount = (name: string, fieldCount?: number) => {
    const layout = PUMP_SCHEMA.accounts.find((a) => a.name === name)!;
    const fields = layout.fields.slice(0, fieldCount ?? layout.fields.length);
    const values = Object.fromEntries(fields.map((f) => [camelCase(f.name), sampleValue(f.type, PUMP_SCHEMA.types)]));
    const disc = layout.discriminator.match(/../g)!.map((h) => parseInt(h, 16));
    return { bytes: new Uint8Array([...disc, ...encodeIdlFields(fields, values, PUMP_SCHEMA.types)]), values };
  };

  it('decodes every field of an account', () => {
    const { bytes, values } = encodeAccount('BondingCurve');
    expect(decodeIdlAccount(PUMP_SCHEMA, 'BondingCurve', bytes)).toEqual(values);
  });

  it('keeps the prefix of an account created before later fields existed', () => {
    const { bytes, values } = encodeAccount('BondingCurve', 7);
    expect(decodeIdlAccount(PUMP_SCHEMA, 'BondingCurve', bytes)).toEqual(values);
  });

  it('ignores trailing padding', () => {
    const { bytes, values } = encodeAccount('BondingCurve');
    const padded = new Uint8Array([...bytes, 0, 0, 0, 0]);
    expect(decodeIdlAccount(PUMP_SCHEMA, 'BondingCurve', padded)).toEqual(values);
  });

  it('rejects the wrong discriminator and unknown account names', () => {
    const { bytes } = encodeAccount('Global');
    expect(() => decodeIdlAccount(PUMP_SCHEMA, 'BondingCurve', bytes)).toThrow(/discriminator mismatch/);
    expect(() => decodeIdlAccount(PUMP_SCHEMA, 'Nope', bytes)).toThrow(/not in schema/);
  });
});
