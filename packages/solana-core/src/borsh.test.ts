import { describe, it, expect } from 'vitest';
import { Reader, Writer } from './borsh';
import { PublicKey } from './public-key';

/**
 * A sprinkle of on-chain flavoured fixtures — same bytes as the PublicKey
 * tests use — so round-tripping a Pubkey through the borsh codec lands on
 * an address that actually exists.
 */
const TOKEN_PROGRAM_BYTES = new Uint8Array([
  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
  28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
const TOKEN_PROGRAM_B58 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('Reader construction and bookkeeping', () => {
  it('starts at offset 0', () => {
    const r = new Reader(new Uint8Array([1, 2, 3]));
    expect(r.offset).toBe(0);
  });

  it('reports remaining() as full buffer length at start', () => {
    const r = new Reader(new Uint8Array([1, 2, 3]));
    expect(r.remaining()).toBe(3);
  });

  it('reports remaining() as 0 when the buffer is empty', () => {
    const r = new Reader(new Uint8Array(0));
    expect(r.remaining()).toBe(0);
    expect(r.offset).toBe(0);
  });

  it('advances offset on successive reads', () => {
    const r = new Reader(new Uint8Array([0x01, 0x02, 0x03]));
    r.readU8();
    expect(r.offset).toBe(1);
    r.readU8();
    expect(r.offset).toBe(2);
    r.readU8();
    expect(r.offset).toBe(3);
    expect(r.remaining()).toBe(0);
  });
});

describe('Reader primitives — integers', () => {
  it('readU8 reads an unsigned byte', () => {
    const r = new Reader(new Uint8Array([0x00, 0x7f, 0xff]));
    expect(r.readU8()).toBe(0x00);
    expect(r.readU8()).toBe(0x7f);
    expect(r.readU8()).toBe(0xff);
    expect(r.offset).toBe(3);
  });

  it('readU16 reads a little-endian u16', () => {
    // 0x1234 little-endian → [0x34, 0x12]
    const r = new Reader(new Uint8Array([0x34, 0x12, 0xff, 0xff]));
    expect(r.readU16()).toBe(0x1234);
    expect(r.readU16()).toBe(0xffff);
    expect(r.offset).toBe(4);
  });

  it('readU32 reads a little-endian u32', () => {
    // 0xdeadbeef little-endian → [0xef, 0xbe, 0xad, 0xde]
    const r = new Reader(new Uint8Array([0xef, 0xbe, 0xad, 0xde]));
    expect(r.readU32()).toBe(0xdeadbeef);
    expect(r.offset).toBe(4);
  });

  it('readU32 handles the u32 maximum', () => {
    const r = new Reader(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(r.readU32()).toBe(0xffffffff);
  });

  it('readU64 returns a bigint and reads little-endian', () => {
    // 1n → [1,0,0,0, 0,0,0,0]
    const r = new Reader(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]));
    const v = r.readU64();
    expect(typeof v).toBe('bigint');
    expect(v).toBe(1n);
    expect(r.offset).toBe(8);
  });

  it('readU64 handles the u64 maximum', () => {
    const r = new Reader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(r.readU64()).toBe(0xffffffffffffffffn);
  });

  it('readI64 returns a bigint and supports negatives (-1 is all 0xff bytes)', () => {
    const r = new Reader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const v = r.readI64();
    expect(typeof v).toBe('bigint');
    expect(v).toBe(-1n);
  });

  it('readI64 reads the i64 minimum', () => {
    // INT64_MIN = -9223372036854775808 → [0,0,0,0, 0,0,0,0x80]
    const r = new Reader(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0x80]));
    expect(r.readI64()).toBe(-9223372036854775808n);
  });

  it('readI64 reads the i64 maximum', () => {
    // INT64_MAX = 9223372036854775807 → [0xff,0xff,0xff,0xff, 0xff,0xff,0xff,0x7f]
    const r = new Reader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]));
    expect(r.readI64()).toBe(9223372036854775807n);
  });
});

describe('Reader primitives — bool', () => {
  it('reads 0x00 as false', () => {
    const r = new Reader(new Uint8Array([0x00]));
    expect(r.readBool()).toBe(false);
    expect(r.offset).toBe(1);
  });

  it('reads 0x01 as true', () => {
    const r = new Reader(new Uint8Array([0x01]));
    expect(r.readBool()).toBe(true);
    expect(r.offset).toBe(1);
  });

  it('throws on any byte that is not 0 or 1, with offset + value in the message', () => {
    const r = new Reader(new Uint8Array([0xaa, 0x02]));
    expect(() => r.readBool()).toThrow(/borsh/i);
    // Rewind by making a fresh reader so we can check the offset value in the message.
    const r2 = new Reader(new Uint8Array([0xff, 0x7f]));
    r2.readU8(); // advance to offset 1
    expect(() => r2.readBool()).toThrow(/offset 1/);
    // And the offending value should be mentioned.
    const r3 = new Reader(new Uint8Array([0x02]));
    expect(() => r3.readBool()).toThrow(/0x02|2/);
  });
});

describe('Reader primitives — bytes', () => {
  it('readBytes(n) returns exactly n bytes and advances the offset by n', () => {
    const r = new Reader(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]));
    const b = r.readBytes(4);
    expect(Array.from(b)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(r.offset).toBe(4);
    expect(r.remaining()).toBe(2);
  });

  it('readBytes(0) returns an empty Uint8Array and does not advance the offset', () => {
    const r = new Reader(new Uint8Array([0x11]));
    const b = r.readBytes(0);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(b.length).toBe(0);
    expect(r.offset).toBe(0);
  });

  it('returns a COPY — mutating the returned array must not touch the underlying buffer', () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const r = new Reader(buf);
    const slice = r.readBytes(4);
    slice[0] = 0xff;
    slice[1] = 0xff;
    // Original buffer is untouched.
    expect(Array.from(buf)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('throws on truncated read, mentioning the offset', () => {
    const r = new Reader(new Uint8Array([0x01, 0x02]));
    expect(() => r.readBytes(5)).toThrow(/borsh/i);
    expect(() => new Reader(new Uint8Array([0x01, 0x02])).readBytes(5)).toThrow(/offset/i);
  });
});

describe('Reader primitives — pubkey', () => {
  it('consumes 32 bytes and returns a PublicKey', () => {
    // 32 bytes of Token program + a trailing sentinel we should not consume.
    const buf = new Uint8Array(33);
    buf.set(TOKEN_PROGRAM_BYTES, 0);
    buf[32] = 0xaa;
    const r = new Reader(buf);
    const pk = r.readPubkey();
    expect(pk).toBeInstanceOf(PublicKey);
    expect(pk.toBase58()).toBe(TOKEN_PROGRAM_B58);
    expect(r.offset).toBe(32);
    expect(r.remaining()).toBe(1);
    expect(r.readU8()).toBe(0xaa);
  });

  it('throws on truncated input', () => {
    const r = new Reader(new Uint8Array(10));
    expect(() => r.readPubkey()).toThrow(/borsh/i);
  });
});

describe('Reader primitives — string', () => {
  it('reads a u32-length-prefixed UTF-8 string', () => {
    // "hi" = [0x68, 0x69], length = 2
    const r = new Reader(new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x68, 0x69]));
    expect(r.readString()).toBe('hi');
    expect(r.offset).toBe(6);
  });

  it('reads the empty string (length 0)', () => {
    const r = new Reader(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    expect(r.readString()).toBe('');
    expect(r.offset).toBe(4);
  });

  it('reads multi-byte UTF-8 correctly (length is BYTES, not code points)', () => {
    // "café" — 5 bytes in UTF-8 (é = 0xc3 0xa9).
    const bytes = new Uint8Array([
      0x05, 0x00, 0x00, 0x00, // length = 5
      0x63, 0x61, 0x66, 0xc3, 0xa9, // "café"
    ]);
    const r = new Reader(bytes);
    expect(r.readString()).toBe('café');
    expect(r.offset).toBe(9);
  });

  it('throws on malformed UTF-8 (fatal decode)', () => {
    // 0xff is never valid as a standalone UTF-8 byte.
    const bytes = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0xff]);
    const r = new Reader(bytes);
    expect(() => r.readString()).toThrow();
  });

  it('throws on truncated string (length declares more bytes than remain)', () => {
    const r = new Reader(new Uint8Array([0x10, 0x00, 0x00, 0x00, 0x68]));
    expect(() => r.readString()).toThrow(/borsh/i);
  });
});

describe('Reader primitives — vec', () => {
  it('reads an empty vec (length prefix 0)', () => {
    const r = new Reader(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    const v = r.readVec((rr) => rr.readU8());
    expect(v).toEqual([]);
    expect(r.offset).toBe(4);
  });

  it('reads a Vec<u8>', () => {
    // length=3, items=[10,20,30]
    const r = new Reader(new Uint8Array([0x03, 0x00, 0x00, 0x00, 0x0a, 0x14, 0x1e]));
    const v = r.readVec((rr) => rr.readU8());
    expect(v).toEqual([10, 20, 30]);
    expect(r.offset).toBe(7);
  });

  it('reads a Vec<u64>', () => {
    // length=2, items=[1n, 2n]
    const bytes = new Uint8Array([
      0x02, 0x00, 0x00, 0x00,
      1, 0, 0, 0, 0, 0, 0, 0,
      2, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const r = new Reader(bytes);
    const v = r.readVec((rr) => rr.readU64());
    expect(v).toEqual([1n, 2n]);
    expect(r.offset).toBe(bytes.length);
  });
});

describe('Reader primitives — option', () => {
  it('reads None (discriminant 0) as null', () => {
    const r = new Reader(new Uint8Array([0x00]));
    const v = r.readOption((rr) => rr.readU8());
    expect(v).toBeNull();
    expect(r.offset).toBe(1);
  });

  it('reads Some (discriminant 1) and the payload', () => {
    const r = new Reader(new Uint8Array([0x01, 0x2a]));
    const v = r.readOption((rr) => rr.readU8());
    expect(v).toBe(0x2a);
    expect(r.offset).toBe(2);
  });

  it('throws on an invalid discriminant (not 0 or 1)', () => {
    const r = new Reader(new Uint8Array([0x02, 0x00]));
    expect(() => r.readOption((rr) => rr.readU8())).toThrow(/borsh/i);
  });
});

describe('Writer', () => {
  it('writeU8 appends one byte', () => {
    const w = new Writer();
    w.writeU8(0xab);
    expect(Array.from(w.toBytes())).toEqual([0xab]);
  });

  it('writeU16 appends little-endian bytes', () => {
    const w = new Writer();
    w.writeU16(0x1234);
    expect(Array.from(w.toBytes())).toEqual([0x34, 0x12]);
  });

  it('writeU32 appends little-endian bytes', () => {
    const w = new Writer();
    w.writeU32(0xdeadbeef);
    expect(Array.from(w.toBytes())).toEqual([0xef, 0xbe, 0xad, 0xde]);
  });

  it('writeU64 accepts bigint and appends little-endian bytes', () => {
    const w = new Writer();
    w.writeU64(1n);
    expect(Array.from(w.toBytes())).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('writeU64 writes the u64 maximum', () => {
    const w = new Writer();
    w.writeU64(0xffffffffffffffffn);
    expect(Array.from(w.toBytes())).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  });

  it('writeI64 writes negative values as two-complement little-endian (-1 → all 0xff)', () => {
    const w = new Writer();
    w.writeI64(-1n);
    expect(Array.from(w.toBytes())).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  });

  it('writeI64 writes INT64_MIN', () => {
    const w = new Writer();
    w.writeI64(-9223372036854775808n);
    expect(Array.from(w.toBytes())).toEqual([0, 0, 0, 0, 0, 0, 0, 0x80]);
  });

  it('writeBool writes 0x00 for false and 0x01 for true', () => {
    const w = new Writer();
    w.writeBool(false);
    w.writeBool(true);
    expect(Array.from(w.toBytes())).toEqual([0x00, 0x01]);
  });

  it('writeBytes appends the bytes verbatim', () => {
    const w = new Writer();
    w.writeBytes(new Uint8Array([0x01, 0x02, 0x03]));
    expect(Array.from(w.toBytes())).toEqual([0x01, 0x02, 0x03]);
  });

  it('writeString prefixes with a u32 byte-length and writes UTF-8', () => {
    const w = new Writer();
    w.writeString('café');
    expect(Array.from(w.toBytes())).toEqual([
      0x05, 0x00, 0x00, 0x00,
      0x63, 0x61, 0x66, 0xc3, 0xa9,
    ]);
  });

  it('writeString handles the empty string', () => {
    const w = new Writer();
    w.writeString('');
    expect(Array.from(w.toBytes())).toEqual([0x00, 0x00, 0x00, 0x00]);
  });

  it('writeVec writes a u32 length prefix then items', () => {
    const w = new Writer();
    w.writeVec([10, 20, 30], (ww, n) => ww.writeU8(n));
    expect(Array.from(w.toBytes())).toEqual([0x03, 0x00, 0x00, 0x00, 0x0a, 0x14, 0x1e]);
  });

  it('writeVec handles an empty vec', () => {
    const w = new Writer();
    w.writeVec<number>([], (ww, n) => ww.writeU8(n));
    expect(Array.from(w.toBytes())).toEqual([0x00, 0x00, 0x00, 0x00]);
  });

  it('writeOption(null) writes 0x00 with no payload', () => {
    const w = new Writer();
    w.writeOption<number>(null, (ww, n) => ww.writeU8(n));
    expect(Array.from(w.toBytes())).toEqual([0x00]);
  });

  it('writeOption(value) writes 0x01 then the payload', () => {
    const w = new Writer();
    w.writeOption(0x2a, (ww, n) => ww.writeU8(n));
    expect(Array.from(w.toBytes())).toEqual([0x01, 0x2a]);
  });

  it('writePubkey writes the 32 raw bytes', () => {
    const w = new Writer();
    const pk = PublicKey.fromBytes(TOKEN_PROGRAM_BYTES);
    w.writePubkey(pk);
    expect(Array.from(w.toBytes())).toEqual(Array.from(TOKEN_PROGRAM_BYTES));
  });

  it('grows across many appends (exercises internal reallocation)', () => {
    const w = new Writer();
    for (let i = 0; i < 1000; i++) w.writeU8(i & 0xff);
    const out = w.toBytes();
    expect(out.length).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(out[i]).toBe(i & 0xff);
    }
  });

  it('toBytes returns a Uint8Array distinct from internal storage (not aliased)', () => {
    const w = new Writer();
    w.writeU8(0x01);
    const a = w.toBytes();
    a[0] = 0xff;
    const b = w.toBytes();
    expect(b[0]).toBe(0x01);
  });

  it('length getter tracks bytes written', () => {
    const w = new Writer();
    expect(w.length).toBe(0);
    w.writeU8(1);
    expect(w.length).toBe(1);
    w.writeU32(0xdeadbeef);
    expect(w.length).toBe(5);
  });
});

describe('round-trip — all primitives', () => {
  it('round-trips u8/u16/u32 across the full range (sparse sweep)', () => {
    const values = [0, 1, 127, 128, 255];
    for (const v of values) {
      const w = new Writer();
      w.writeU8(v);
      expect(new Reader(w.toBytes()).readU8()).toBe(v);
    }
    const u16s = [0, 1, 255, 256, 65535];
    for (const v of u16s) {
      const w = new Writer();
      w.writeU16(v);
      expect(new Reader(w.toBytes()).readU16()).toBe(v);
    }
    const u32s = [0, 1, 0xffff, 0xffffff, 0xffffffff];
    for (const v of u32s) {
      const w = new Writer();
      w.writeU32(v);
      expect(new Reader(w.toBytes()).readU32()).toBe(v);
    }
  });

  it('round-trips u64 boundary values', () => {
    const values: bigint[] = [
      0n,
      1n,
      0xffffffffn,
      0x100000000n,
      0xffffffffffffffffn,
    ];
    for (const v of values) {
      const w = new Writer();
      w.writeU64(v);
      expect(new Reader(w.toBytes()).readU64()).toBe(v);
    }
  });

  it('round-trips i64 boundary values including negatives', () => {
    const values: bigint[] = [
      -9223372036854775808n,
      -1n,
      0n,
      1n,
      9223372036854775807n,
    ];
    for (const v of values) {
      const w = new Writer();
      w.writeI64(v);
      expect(new Reader(w.toBytes()).readI64()).toBe(v);
    }
  });

  it('round-trips bool', () => {
    for (const v of [false, true]) {
      const w = new Writer();
      w.writeBool(v);
      expect(new Reader(w.toBytes()).readBool()).toBe(v);
    }
  });

  it('round-trips pubkey', () => {
    const pk = PublicKey.fromBytes(TOKEN_PROGRAM_BYTES);
    const w = new Writer();
    w.writePubkey(pk);
    const got = new Reader(w.toBytes()).readPubkey();
    expect(got.toBase58()).toBe(TOKEN_PROGRAM_B58);
  });

  it('round-trips string (ASCII, multi-byte UTF-8, empty, long)', () => {
    const cases = [
      '',
      'hello',
      'café',
      'こんにちは',
      '🚀 to the moon 🌕',
      'x'.repeat(10_000),
    ];
    for (const s of cases) {
      const w = new Writer();
      w.writeString(s);
      expect(new Reader(w.toBytes()).readString()).toBe(s);
    }
  });

  it('round-trips Vec<u64>', () => {
    const vals = [0n, 1n, 2n, 0xdeadbeefn];
    const w = new Writer();
    w.writeVec(vals, (ww, n) => ww.writeU64(n));
    const got = new Reader(w.toBytes()).readVec((r) => r.readU64());
    expect(got).toEqual(vals);
  });

  it('round-trips Option<PublicKey> for both Some and None', () => {
    const pk = PublicKey.fromBytes(TOKEN_PROGRAM_BYTES);

    const wSome = new Writer();
    wSome.writeOption(pk, (w, v) => w.writePubkey(v));
    const gotSome = new Reader(wSome.toBytes()).readOption((r) => r.readPubkey());
    expect(gotSome).not.toBeNull();
    expect(gotSome!.toBase58()).toBe(TOKEN_PROGRAM_B58);

    const wNone = new Writer();
    wNone.writeOption<PublicKey>(null, (w, v) => w.writePubkey(v));
    const gotNone = new Reader(wNone.toBytes()).readOption((r) => r.readPubkey());
    expect(gotNone).toBeNull();
  });

  it('round-trips a compound record (mimicking a minimal mint account-ish layout)', () => {
    // { mintAuthority: Option<Pubkey>, supply: u64, decimals: u8, isInitialized: bool, name: string }
    const pk = PublicKey.fromBytes(TOKEN_PROGRAM_BYTES);
    const w = new Writer();
    w.writeOption(pk, (ww, v) => ww.writePubkey(v));
    w.writeU64(1_000_000_000n);
    w.writeU8(6);
    w.writeBool(true);
    w.writeString('SOL-ish');

    const r = new Reader(w.toBytes());
    const mintAuth = r.readOption((rr) => rr.readPubkey());
    const supply = r.readU64();
    const decimals = r.readU8();
    const isInit = r.readBool();
    const name = r.readString();

    expect(mintAuth).not.toBeNull();
    expect(mintAuth!.toBase58()).toBe(TOKEN_PROGRAM_B58);
    expect(supply).toBe(1_000_000_000n);
    expect(decimals).toBe(6);
    expect(isInit).toBe(true);
    expect(name).toBe('SOL-ish');
    expect(r.remaining()).toBe(0);
  });
});

describe('Reader — truncated primitive reads throw with offset context', () => {
  it('readU8 throws past end of buffer', () => {
    const r = new Reader(new Uint8Array(0));
    expect(() => r.readU8()).toThrow(/borsh/i);
  });

  it('readU16 throws on only 1 remaining byte', () => {
    const r = new Reader(new Uint8Array([0x01]));
    expect(() => r.readU16()).toThrow(/borsh/i);
  });

  it('readU32 throws on 3 remaining bytes', () => {
    const r = new Reader(new Uint8Array([0x01, 0x02, 0x03]));
    expect(() => r.readU32()).toThrow(/borsh/i);
  });

  it('readU64 throws on 7 remaining bytes', () => {
    const r = new Reader(new Uint8Array(7));
    expect(() => r.readU64()).toThrow(/borsh/i);
  });

  it('readI64 throws on 7 remaining bytes', () => {
    const r = new Reader(new Uint8Array(7));
    expect(() => r.readI64()).toThrow(/borsh/i);
  });
});
