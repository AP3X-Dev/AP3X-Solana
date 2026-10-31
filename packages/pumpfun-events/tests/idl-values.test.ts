import { describe, expect, it } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { encodeIdlValue, encodeIdlFields } from '../src/idl-encoder.js';
import { decodeIdlEvent } from '../src/idl-decoder.js';
import type { IdlProgramSchema, IdlType, IdlTypeDef } from '../src/idl-types.js';

const discriminator = [1, 2, 3, 4, 5, 6, 7, 8];
function decode(type: IdlType, bytes: number[], types: Record<string, IdlTypeDef> = {}) {
  const schema: IdlProgramSchema = { address: '', instructions: [], accounts: [], types,
    events: [{ name: 'ValueEvent', discriminator: '0102030405060708', fields: [{ name: 'value', type }] }] };
  return decodeIdlEvent(schema, Uint8Array.of(...discriminator, ...bytes))?.fields['value'];
}

describe('IDL values at their wire boundaries', () => {
  for (const bits of [8, 16, 32, 64, 128]) for (const signed of [false, true]) {
    const type = `${signed ? 'i' : 'u'}${bits}`;
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const max = (1n << BigInt(bits - (signed ? 1 : 0))) - 1n;
    it(`${type} preserves both limits and refuses wraparound`, () => {
      const low = Array(bits / 8).fill(0); if (signed) low[low.length - 1] = 128;
      const high = Array(bits / 8).fill(255); if (signed) high[high.length - 1] = 127;
      expect(encodeIdlValue(type, min, {})).toEqual(low);
      expect(encodeIdlValue(type, max.toString(), {})).toEqual(high);
      expect(decode(type, low)).toBe(bits <= 32 ? Number(min) : min);
      expect(decode(type, high)).toBe(bits <= 32 ? Number(max) : max);
      expect(() => encodeIdlValue(type, min - 1n, {})).toThrow();
      expect(() => encodeIdlValue(type, max + 1n, {})).toThrow();
    });
  }
  it('refuses rounded numeric inputs and implicit integer coercions', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 0.5, NaN, Infinity, true, null, undefined, '', '1.5', {}])
      expect(() => encodeIdlValue('u64', value, {})).toThrow();
    expect(encodeIdlValue('u64', Number.MAX_SAFE_INTEGER, {})).toEqual([255, 255, 255, 255, 255, 255, 31, 0]);
  });
  it('bool and option tags are canonical, and required bool fields cannot silently become false', () => {
    expect(encodeIdlValue('bool', false, {})).toEqual([0]);
    expect(decode('bool', [1])).toBe(true);
    for (const value of [0, 1, 'false', null, undefined]) expect(() => encodeIdlValue('bool', value, {})).toThrow();
    for (const tag of [2, 255]) {
      expect(() => decode('bool', [tag])).toThrow();
      expect(() => decode({ option: 'u8' }, [tag, 9])).toThrow();
    }
    expect(encodeIdlValue({ option: 'u8' }, null, {})).toEqual([0]);
    expect(encodeIdlValue({ option: 'u8' }, undefined, {})).toEqual([0]);
    expect(decode({ option: 'u8' }, [0])).toBeNull();
    expect(decode({ option: 'u8' }, [1, 9])).toBe(9);
    expect(encodeIdlValue({ option: 'u8' }, 9, {})).toEqual([1, 9]);
    expect(() => encodeIdlFields([{ name: 'required', type: 'bool' }], {}, {})).toThrow();
  });
  it('checks fixed array and tuple lengths rather than changing the wire layout', () => {
    expect(encodeIdlValue({ array: ['u8', 2] }, [1, 2], {})).toEqual([1, 2]);
    expect(decode({ array: ['u8', 2] }, [1, 2])).toEqual([1, 2]);
    for (const value of [[], [1], [1, 2, 3], '12'])
      expect(() => encodeIdlValue({ array: ['u8', 2] }, value, {})).toThrow();
    const types: Record<string, IdlTypeDef> = { Pair: { kind: 'struct', fields: ['u8', 'bool'] } };
    expect(encodeIdlValue({ defined: { name: 'Pair' } }, [7, true], types)).toEqual([7, 1]);
    expect(decode({ defined: { name: 'Pair' } }, [7, 1], types)).toEqual([7, true]);
    for (const value of [[], [7], [7, true, 9]])
      expect(() => encodeIdlValue({ defined: { name: 'Pair' } }, value, types)).toThrow();
  });
  it('preserves UTF-8 and bytes and refuses lossy or wrong-shaped inputs', () => {
    expect(encodeIdlValue('string', 'é', {})).toEqual([2, 0, 0, 0, 195, 169]);
    expect(decode('string', [2, 0, 0, 0, 195, 169])).toBe('é');
    expect(() => decode('string', [1, 0, 0, 0, 255])).toThrow();
    expect(() => encodeIdlValue('string', '\ud800', {})).toThrow();
    expect(() => encodeIdlValue('string', 123, {})).toThrow();
    expect(encodeIdlValue('bytes', Uint8Array.of(7, 9), {})).toEqual([2, 0, 0, 0, 7, 9]);
    expect(decode('bytes', [2, 0, 0, 0, 7, 9])).toEqual(Uint8Array.of(7, 9));
    expect(() => encodeIdlValue('bytes', [7, 9], {})).toThrow();
    expect(encodeIdlValue({ vec: 'u8' }, [7, 9], {})).toEqual([2, 0, 0, 0, 7, 9]);
    expect(decode({ vec: 'u8' }, [2, 0, 0, 0, 7, 9])).toEqual([7, 9]);
    expect(() => encodeIdlValue({ vec: 'u8' }, '79', {})).toThrow();
  });
  it('preserves named/tuple/unit enum variants and refuses unknown or unencodable variants', () => {
    const types: Record<string, IdlTypeDef> = {
      Empty: { kind: 'struct' },
      Action: { kind: 'enum', variants: [{ name: 'Wait' }, { name: 'Tuple', fields: ['i16', 'bool'] },
        { name: 'Named', fields: [{ name: 'route_tag', type: 'u8' }] }, { name: 'Empty', fields: [] }] },
    };
    const type = { defined: { name: 'Action' } };
    for (const [value, bytes] of [
      ['Wait', [0]], [{ variant: 'Tuple', fields: [-2, true] }, [1, 254, 255, 1]],
      [{ variant: 'Named', fields: { routeTag: 7 } }, [2, 7]], [{ variant: 'Empty' }, [3]],
    ] as const) {
      expect(encodeIdlValue(type, value, types)).toEqual(bytes);
      expect(decode(type, [...bytes], types)).toEqual(value === 'Wait' ? value
        : value.variant === 'Empty' ? { variant: 'Empty', fields: {} } : value);
    }
    expect(encodeIdlValue({ defined: { name: 'Empty' } }, {}, types)).toEqual([]);
    expect(() => encodeIdlValue(type, 'Unknown', types)).toThrow(/variant/);
    expect(() => decode(type, [255], types)).toThrow(/variant/);
    const tooMany: Record<string, IdlTypeDef> = { Action: { kind: 'enum', variants: Array.from({ length: 257 }, (_, n) => ({ name: String(n) })) } };
    expect(() => encodeIdlValue(type, '256', tooMany)).toThrow();
  });
  it('checks pubkeys, missing definitions and unsupported types', () => {
    const key = PublicKey.fromBytes(new Uint8Array(32).fill(7));
    expect(encodeIdlValue('pubkey', key, {})).toEqual(Array(32).fill(7));
    expect(decode('pubkey', Array(32).fill(7))).toEqual(key);
    expect(() => encodeIdlValue('pubkey', { toBuffer: () => new Uint8Array(31) }, {})).toThrow();
    expect(() => encodeIdlValue({ defined: { name: 'Missing' } }, {}, {})).toThrow(/schema/);
    expect(() => decode({ defined: { name: 'Missing' } }, [0])).toThrow(/schema/);
    expect(() => encodeIdlValue('unsupported', 0, {})).toThrow(/unsupported/);
    expect(() => decode('unsupported', [0])).toThrow(/unsupported/);
  });
});
