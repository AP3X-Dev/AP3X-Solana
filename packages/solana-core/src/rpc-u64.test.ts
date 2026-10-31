import { describe, expect, it } from 'vitest';
import { rpcU64 } from './rpc-u64';

describe('rpcU64', () => {
  it('retains exact integer representations including the full u64 string/bigint range', () => {
    for (const [input, expected] of [[0, 0n], [0n, 0n], ['0', 0n], [Number.MAX_SAFE_INTEGER, 9007199254740991n],
      ['9007199254740993', 9007199254740993n], ['18446744073709551615', 18446744073709551615n],
      [18446744073709551615n, 18446744073709551615n]] as const) expect(rpcU64(input)).toBe(expected);
  });
  it('refuses absence, rounded numbers, signs, noncanonical strings and out-of-range values', () => {
    for (const input of [undefined, null, true, {}, NaN, Infinity, -1, -1n, 0.5, Number.MAX_SAFE_INTEGER + 1,
      '', ' 1', '1 ', '+1', '-1', '01', '1.0', '1e3', '18446744073709551616', 18446744073709551616n])
      expect(() => rpcU64(input, 'network fee')).toThrow(/network fee.*exact unsigned/);
  });
});
