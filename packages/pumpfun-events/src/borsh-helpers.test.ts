import { describe, it, expect } from 'vitest';
import {
  readU8, readU16LE, readU32LE, readU64LE, readI64LE,
  readFixedBytes, readVecU8, readString, readPublicKey,
  BorshReader,
} from './borsh-helpers.js';

describe('BorshReader', () => {
  it('reads u64 little-endian', () => {
    const buf = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const r = new BorshReader(buf);
    expect(r.readU64LE()).toBe(1n);
    expect(r.remaining()).toBe(0);
  });

  it('reads u64 with high bits', () => {
    // 2^33 = 8589934592 little-endian bytes
    const buf = new Uint8Array([0, 0, 0, 0, 0x02, 0, 0, 0]);
    const r = new BorshReader(buf);
    expect(r.readU64LE()).toBe(8589934592n);
  });

  it('reads a PublicKey (32 bytes)', () => {
    const pkBytes = new Uint8Array(32).fill(1);
    const r = new BorshReader(pkBytes);
    const pk = r.readPublicKey();
    expect(pk.toBuffer()).toEqual(pkBytes);
  });

  it('reads a Borsh string (u32 length prefix + utf8)', () => {
    // "test" = 4 bytes len + "test"
    const buf = new Uint8Array([4, 0, 0, 0, 0x74, 0x65, 0x73, 0x74]);
    const r = new BorshReader(buf);
    expect(r.readString()).toBe('test');
  });

  it('throws TruncatedBufferError when out of bytes', () => {
    const r = new BorshReader(new Uint8Array([1, 2, 3]));
    expect(() => r.readU64LE()).toThrow(/truncated/i);
  });
});
