import { describe, it, expect } from 'vitest';
import vectors from '../tests/fixtures/base58-vectors.json' with { type: 'json' };
import { encode, decode } from './base58';

describe('base58', () => {
  for (const v of vectors) {
    it(`encodes ${v.label}`, () => {
      expect(encode(new Uint8Array(v.bytes))).toBe(v.encoded);
    });
    it(`decodes ${v.label}`, () => {
      expect(Array.from(decode(v.encoded))).toEqual(v.bytes);
    });
  }

  it('round-trips 1000 random 32-byte values', () => {
    for (let i = 0; i < 1000; i++) {
      const buf = crypto.getRandomValues(new Uint8Array(32));
      expect(Array.from(decode(encode(buf)))).toEqual(Array.from(buf));
    }
  });

  it('round-trips random-length values (0..64 bytes)', () => {
    for (let len = 0; len <= 64; len++) {
      const buf = crypto.getRandomValues(new Uint8Array(len));
      expect(Array.from(decode(encode(buf)))).toEqual(Array.from(buf));
    }
  });

  it('matches the BigInt reference on random values with leading zeros', () => {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const reference = (bytes: Uint8Array): string => {
      let zeros = 0;
      while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
      let n = 0n;
      for (const b of bytes) n = (n << 8n) | BigInt(b);
      let out = '';
      while (n > 0n) { out = A[Number(n % 58n)]! + out; n /= 58n; }
      return '1'.repeat(zeros) + out;
    };
    for (let i = 0; i < 2000; i++) {
      const buf = crypto.getRandomValues(new Uint8Array(i % 97));
      buf.fill(0, 0, i % 5);
      if (i % 11 === 0) buf.fill(255);
      const enc = encode(buf);
      expect(enc).toBe(reference(buf));
      expect(Array.from(decode(enc))).toEqual(Array.from(buf));
    }
  });

  it('throws on invalid chars', () => {
    expect(() => decode('0')).toThrow(/base58/i);
    expect(() => decode('O')).toThrow(/base58/i);
    expect(() => decode('I')).toThrow(/base58/i);
    expect(() => decode('l')).toThrow(/base58/i);
    expect(() => decode('abc!')).toThrow(/base58/i);
    expect(() => decode('abc 123')).toThrow(/base58/i);
  });

  it('throws on non-ASCII chars', () => {
    expect(() => decode('ab\u00e9')).toThrow(/base58/i);
    expect(() => decode('\u{1F600}')).toThrow(/base58/i);
  });

  it('handles empty input on both sides', () => {
    expect(encode(new Uint8Array(0))).toBe('');
    expect(decode('').length).toBe(0);
  });

  it('preserves all-zero prefixes on encode', () => {
    // 5 leading zero bytes → 5 leading "1" chars, rest encodes normally
    const bytes = new Uint8Array([0, 0, 0, 0, 0, 1, 2, 3]);
    const enc = encode(bytes);
    expect(enc.startsWith('11111')).toBe(true);
    expect(Array.from(decode(enc))).toEqual([0, 0, 0, 0, 0, 1, 2, 3]);
  });

  it('preserves all-zero prefixes on decode', () => {
    // "1111..." → N leading zero bytes
    expect(Array.from(decode('11111'))).toEqual([0, 0, 0, 0, 0]);
  });
});
