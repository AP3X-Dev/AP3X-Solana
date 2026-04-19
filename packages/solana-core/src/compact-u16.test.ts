import { describe, it, expect } from 'vitest';
import { encode, decode } from './compact-u16';

/**
 * Canonical shortvec vectors. Each entry is `[value, encoded bytes]`. These
 * are the exact byte sequences emitted by the reference Solana implementation
 * (compare with `solana_program::short_vec::encode_len`).
 */
const VECTORS: ReadonlyArray<readonly [number, number[]]> = [
  [0, [0x00]],
  [1, [0x01]],
  [127, [0x7f]],
  [128, [0x80, 0x01]],
  [16383, [0xff, 0x7f]],
  [16384, [0x80, 0x80, 0x01]],
  [65535, [0xff, 0xff, 0x03]],
];

describe('compact-u16 encode', () => {
  for (const [value, bytes] of VECTORS) {
    it(`encodes ${value} → [${bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`, () => {
      expect(Array.from(encode(value))).toEqual(bytes);
    });
  }

  it('throws on negative values', () => {
    expect(() => encode(-1)).toThrow(RangeError);
    expect(() => encode(-100)).toThrow(/compact-u16/i);
  });

  it('throws on values greater than 65535', () => {
    expect(() => encode(65536)).toThrow(RangeError);
    expect(() => encode(1_000_000)).toThrow(/compact-u16/i);
  });

  it('throws on non-integer numbers', () => {
    expect(() => encode(1.5)).toThrow(RangeError);
    expect(() => encode(Number.NaN)).toThrow(/compact-u16/i);
    expect(() => encode(Number.POSITIVE_INFINITY)).toThrow(/compact-u16/i);
  });
});

describe('compact-u16 decode', () => {
  for (const [value, bytes] of VECTORS) {
    it(`decodes [${bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}] → ${value}`, () => {
      const result = decode(new Uint8Array(bytes), 0);
      expect(result.value).toBe(value);
      expect(result.length).toBe(bytes.length);
    });
  }

  it('decodes at non-zero offsets (skip a leading header byte)', () => {
    // Prefix with a throwaway byte; the caller advances past it via `offset`.
    const buf = new Uint8Array([0xaa, 0x80, 0x01]);
    const result = decode(buf, 1);
    expect(result.value).toBe(128);
    expect(result.length).toBe(2);
  });

  it('decodes back-to-back shortvecs when the caller chains offsets', () => {
    // Simulates how Solana transaction parsing chains length prefixes.
    const buf = new Uint8Array([0x7f, 0x80, 0x01, 0x00]);
    const first = decode(buf, 0);
    expect(first).toEqual({ value: 127, length: 1 });
    const second = decode(buf, first.length);
    expect(second).toEqual({ value: 128, length: 2 });
    const third = decode(buf, first.length + second.length);
    expect(third).toEqual({ value: 0, length: 1 });
  });

  it('throws on truncated input — continuation bit but no next byte', () => {
    // 0x80 says "more follows", but the buffer has no next byte.
    expect(() => decode(new Uint8Array([0x80]), 0)).toThrow(/compact-u16/i);
  });

  it('throws on truncated input — two continuation bits with no final byte', () => {
    expect(() => decode(new Uint8Array([0x80, 0x80]), 0)).toThrow(/compact-u16/i);
  });

  it('throws when more than 3 bytes would be needed (u16 cap)', () => {
    // Four bytes all with the continuation bit — this exceeds the u16 cap and
    // the decoder must refuse to continue beyond 3 bytes.
    expect(() => decode(new Uint8Array([0x80, 0x80, 0x80, 0x01]), 0)).toThrow(
      /compact-u16/i,
    );
  });
});

describe('compact-u16 round-trip', () => {
  it('round-trips 1000 random values in [0, 65535]', () => {
    for (let i = 0; i < 1000; i++) {
      const n = Math.floor(Math.random() * 65536);
      const encoded = encode(n);
      const decoded = decode(encoded, 0);
      expect(decoded.value).toBe(n);
      expect(decoded.length).toBe(encoded.length);
    }
  });

  it('round-trips every boundary value in [0, 65535]', () => {
    // A tight sweep of the values near each byte-length boundary plus endpoints.
    const boundaries = [0, 1, 126, 127, 128, 129, 16382, 16383, 16384, 16385, 65534, 65535];
    for (const n of boundaries) {
      const encoded = encode(n);
      const decoded = decode(encoded, 0);
      expect(decoded.value).toBe(n);
      expect(decoded.length).toBe(encoded.length);
    }
  });
});
