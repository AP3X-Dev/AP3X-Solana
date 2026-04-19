import { describe, it, expect } from 'vitest';
import { PublicKey } from './public-key';

// Known on-chain pubkeys — byte arrays are lifted from the T2 base58 vectors,
// which were themselves verified against real Solana program IDs.
const SYSTEM_PROGRAM_B58 = '11111111111111111111111111111111';
const SYSTEM_PROGRAM_BYTES = new Uint8Array(32); // 32 zero bytes

const TOKEN_PROGRAM_B58 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_BYTES = new Uint8Array([
  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
  28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);

const TOKEN_2022_B58 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_2022_BYTES = new Uint8Array([
  6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218,
  182, 26, 252, 77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);

const ATA_PROGRAM_B58 = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ATA_PROGRAM_BYTES = new Uint8Array([
  140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11,
  90, 19, 153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
]);

const METAPLEX_B58 = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const METAPLEX_BYTES = new Uint8Array([
  11, 112, 101, 177, 227, 209, 124, 69, 56, 157, 82, 127, 107, 4, 195, 205, 88,
  184, 108, 115, 26, 160, 253, 181, 73, 182, 209, 188, 3, 248, 41, 70,
]);

const FIXTURES: ReadonlyArray<{ label: string; b58: string; bytes: Uint8Array }> = [
  { label: 'SYSTEM_PROGRAM', b58: SYSTEM_PROGRAM_B58, bytes: SYSTEM_PROGRAM_BYTES },
  { label: 'TOKEN_PROGRAM', b58: TOKEN_PROGRAM_B58, bytes: TOKEN_PROGRAM_BYTES },
  { label: 'TOKEN_2022', b58: TOKEN_2022_B58, bytes: TOKEN_2022_BYTES },
  { label: 'ATA_PROGRAM', b58: ATA_PROGRAM_B58, bytes: ATA_PROGRAM_BYTES },
  { label: 'METAPLEX_TOKEN_METADATA', b58: METAPLEX_B58, bytes: METAPLEX_BYTES },
];

describe('PublicKey', () => {
  describe('fromBase58 / toBase58 round-trips', () => {
    for (const f of FIXTURES) {
      it(`${f.label}: fromBase58 → toBase58 returns input`, () => {
        const pk = PublicKey.fromBase58(f.b58);
        expect(pk.toBase58()).toBe(f.b58);
      });
    }
  });

  describe('fromBytes → toBase58 matches expected', () => {
    for (const f of FIXTURES) {
      it(`${f.label}: fromBytes(bytes).toBase58() === expected`, () => {
        const pk = PublicKey.fromBytes(f.bytes);
        expect(pk.toBase58()).toBe(f.b58);
      });
    }
  });

  describe('toBuffer', () => {
    it('returns a Uint8Array of length 32', () => {
      const pk = PublicKey.fromBase58(TOKEN_PROGRAM_B58);
      const buf = pk.toBuffer();
      expect(buf).toBeInstanceOf(Uint8Array);
      expect(buf.length).toBe(32);
    });

    it('returns bytes matching the source', () => {
      const pk = PublicKey.fromBytes(TOKEN_PROGRAM_BYTES);
      expect(Array.from(pk.toBuffer())).toEqual(Array.from(TOKEN_PROGRAM_BYTES));
    });

    it('returns a distinct copy — mutating the buffer does not affect the PublicKey', () => {
      const pk = PublicKey.fromBase58(TOKEN_PROGRAM_B58);
      const buf = pk.toBuffer();
      // Corrupt the returned buffer aggressively.
      for (let i = 0; i < buf.length; i++) buf[i] = 0xff;
      // The PublicKey's own base58 output must be unchanged.
      expect(pk.toBase58()).toBe(TOKEN_PROGRAM_B58);
      // And a freshly-read buffer must still match the original.
      const buf2 = pk.toBuffer();
      expect(Array.from(buf2)).toEqual(Array.from(TOKEN_PROGRAM_BYTES));
    });

    it('two calls to toBuffer return distinct references', () => {
      const pk = PublicKey.fromBase58(TOKEN_PROGRAM_B58);
      const a = pk.toBuffer();
      const b = pk.toBuffer();
      expect(a).not.toBe(b);
    });

    it('mutating the input Uint8Array after construction does not mutate the PublicKey', () => {
      const bytes = new Uint8Array(TOKEN_PROGRAM_BYTES);
      const pk = PublicKey.fromBytes(bytes);
      // Scribble over the caller's array.
      bytes.fill(0);
      expect(pk.toBase58()).toBe(TOKEN_PROGRAM_B58);
    });
  });

  describe('equals', () => {
    it('is reflexive', () => {
      const pk = PublicKey.fromBase58(TOKEN_PROGRAM_B58);
      expect(pk.equals(pk)).toBe(true);
    });

    it('is symmetric for equal pubkeys', () => {
      const a = PublicKey.fromBase58(TOKEN_PROGRAM_B58);
      const b = PublicKey.fromBytes(TOKEN_PROGRAM_BYTES);
      expect(a.equals(b)).toBe(true);
      expect(b.equals(a)).toBe(true);
    });

    it('returns false for different pubkeys', () => {
      const a = PublicKey.fromBase58(TOKEN_PROGRAM_B58);
      const b = PublicKey.fromBase58(TOKEN_2022_B58);
      expect(a.equals(b)).toBe(false);
      expect(b.equals(a)).toBe(false);
    });

    it('returns false for SYSTEM_PROGRAM vs TOKEN_PROGRAM', () => {
      const a = PublicKey.fromBase58(SYSTEM_PROGRAM_B58);
      const b = PublicKey.fromBase58(TOKEN_PROGRAM_B58);
      expect(a.equals(b)).toBe(false);
    });

    it('returns false for a non-PublicKey argument', () => {
      const pk = PublicKey.fromBase58(TOKEN_PROGRAM_B58);
      // Cast through unknown to exercise the runtime guard.
      expect(pk.equals(undefined as unknown as PublicKey)).toBe(false);
      expect(pk.equals(null as unknown as PublicKey)).toBe(false);
      expect(pk.equals('not a pubkey' as unknown as PublicKey)).toBe(false);
      expect(pk.equals({} as unknown as PublicKey)).toBe(false);
      expect(pk.equals(TOKEN_PROGRAM_BYTES as unknown as PublicKey)).toBe(false);
    });

    it('returns false when a single byte differs', () => {
      const orig = new Uint8Array(TOKEN_PROGRAM_BYTES);
      const tweaked = new Uint8Array(TOKEN_PROGRAM_BYTES);
      tweaked[31] = tweaked[31]! ^ 0x01;
      const a = PublicKey.fromBytes(orig);
      const b = PublicKey.fromBytes(tweaked);
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('toString', () => {
    it('returns the same string as toBase58', () => {
      for (const f of FIXTURES) {
        const pk = PublicKey.fromBase58(f.b58);
        expect(pk.toString()).toBe(pk.toBase58());
        expect(pk.toString()).toBe(f.b58);
      }
    });
  });

  describe('fromBytes length validation', () => {
    it('rejects 0-byte input with a descriptive error', () => {
      expect(() => PublicKey.fromBytes(new Uint8Array(0))).toThrow(/32/);
      expect(() => PublicKey.fromBytes(new Uint8Array(0))).toThrow(/0/);
    });

    it('rejects 31-byte input with a descriptive error', () => {
      expect(() => PublicKey.fromBytes(new Uint8Array(31))).toThrow(/32/);
      expect(() => PublicKey.fromBytes(new Uint8Array(31))).toThrow(/31/);
    });

    it('rejects 33-byte input with a descriptive error', () => {
      expect(() => PublicKey.fromBytes(new Uint8Array(33))).toThrow(/32/);
      expect(() => PublicKey.fromBytes(new Uint8Array(33))).toThrow(/33/);
    });

    it('rejects 64-byte input (signature-sized) with a descriptive error', () => {
      expect(() => PublicKey.fromBytes(new Uint8Array(64))).toThrow(/32/);
      expect(() => PublicKey.fromBytes(new Uint8Array(64))).toThrow(/64/);
    });
  });

  describe('fromBase58 error propagation', () => {
    it('rejects invalid base58 alphabet (letter 0)', () => {
      expect(() => PublicKey.fromBase58('0OIl')).toThrow(/base58/i);
    });

    it('rejects invalid base58 alphabet (letter O)', () => {
      // 'O' is not in the Bitcoin alphabet.
      expect(() => PublicKey.fromBase58('TokenOegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toThrow(
        /base58/i,
      );
    });

    it('rejects base58 that decodes to wrong length (1 byte)', () => {
      // '1' → [0], a single zero byte, which is not 32 long.
      expect(() => PublicKey.fromBase58('1')).toThrow(/32/);
    });

    it('rejects base58 that decodes to too-long output (64-byte signature)', () => {
      // A 64-byte all-zero sequence encodes to 64 '1' characters.
      const sixtyFourOnes = '1'.repeat(64);
      expect(() => PublicKey.fromBase58(sixtyFourOnes)).toThrow(/32/);
    });

    it('rejects empty base58 string', () => {
      expect(() => PublicKey.fromBase58('')).toThrow(/32/);
    });
  });
});
