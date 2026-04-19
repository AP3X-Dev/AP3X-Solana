import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import { PublicKey } from '@ap3x/solana-core';

import {
  decodeAlt,
  findInstructionsForKeys,
  LOOKUP_TABLE_META_SIZE,
  type AddressLookupTable,
} from './address-lookup-table';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(__dirname, '..', 'tests', 'fixtures', 'alt-samples.json');

interface AltVector {
  label: string;
  dataBase64: string;
  expected: {
    deactivationSlot: string;
    lastExtendedSlot: string;
    lastExtendedSlotStartIndex: number;
    authority: string | null;
    addresses: string[];
  };
}

const VECTORS = JSON.parse(readFileSync(vectorsPath, 'utf8')) as AltVector[];

function dataOf(v: AltVector): Uint8Array {
  return new Uint8Array(Buffer.from(v.dataBase64, 'base64'));
}

describe('decodeAlt — fixture parity', () => {
  it('has 5 fixture samples', () => {
    expect(VECTORS).toHaveLength(5);
  });

  for (const v of VECTORS) {
    it(`decodes ${v.label}`, () => {
      const decoded = decodeAlt({ data: dataOf(v) });
      expect(decoded.deactivationSlot.toString()).toBe(v.expected.deactivationSlot);
      expect(decoded.lastExtendedSlot.toString()).toBe(v.expected.lastExtendedSlot);
      expect(decoded.lastExtendedSlotStartIndex).toBe(v.expected.lastExtendedSlotStartIndex);
      if (v.expected.authority === null) {
        expect(decoded.authority).toBeNull();
      } else {
        expect(decoded.authority).not.toBeNull();
        expect(decoded.authority!.toBase58()).toBe(v.expected.authority);
      }
      expect(decoded.addresses.map((a) => a.toBase58())).toEqual(v.expected.addresses);
    });
  }
});

describe('decodeAlt — error paths', () => {
  it('throws when data is too short for the header', () => {
    expect(() => decodeAlt({ data: new Uint8Array(10) })).toThrow(/data too short/);
  });

  it('throws on unexpected discriminator', () => {
    const bad = new Uint8Array(LOOKUP_TABLE_META_SIZE);
    // discriminator = 0 (Uninitialized)
    bad[0] = 0;
    expect(() => decodeAlt({ data: bad })).toThrow(/unexpected discriminator 0/);
  });

  it('throws on invalid authority option tag', () => {
    const bad = new Uint8Array(LOOKUP_TABLE_META_SIZE);
    // discriminator = 1
    bad[0] = 1;
    // authority tag at offset 21 set to invalid value
    bad[21] = 7;
    expect(() => decodeAlt({ data: bad })).toThrow(/invalid authority option tag 7/);
  });

  it('throws when trailing address region is mis-aligned', () => {
    // Build a minimal valid header + 31 trailing bytes (not a multiple of 32)
    const bad = new Uint8Array(LOOKUP_TABLE_META_SIZE + 31);
    bad[0] = 1;
    // authority tag = 0 → None (acceptable)
    expect(() => decodeAlt({ data: bad })).toThrow(/not a multiple of 32/);
  });

  it('decodes exactly at the minimum 56-byte size (zero addresses)', () => {
    const bytes = new Uint8Array(LOOKUP_TABLE_META_SIZE);
    bytes[0] = 1;
    // deactivation + lastExt + startIndex + option tag all zero (none)
    const decoded = decodeAlt({ data: bytes });
    expect(decoded.addresses).toHaveLength(0);
    expect(decoded.authority).toBeNull();
    expect(decoded.deactivationSlot).toBe(0n);
  });
});

// -------------------------------------------------------------------------
// findInstructionsForKeys
// -------------------------------------------------------------------------

function altWithAddresses(addrs: string[]): AddressLookupTable {
  return {
    deactivationSlot: 0xffffffffffffffffn,
    lastExtendedSlot: 0n,
    lastExtendedSlotStartIndex: 0,
    authority: null,
    addresses: addrs.map((a) => PublicKey.fromBase58(a)),
  };
}

describe('findInstructionsForKeys', () => {
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  const WSOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

  it('returns an empty list when no ALTs are supplied', () => {
    expect(findInstructionsForKeys([], [PublicKey.fromBase58(TOKEN)])).toEqual([]);
  });

  it('returns an empty list when no required keys are covered', () => {
    const alt = altWithAddresses([TOKEN]);
    const required = [PublicKey.fromBase58(USDC)];
    expect(findInstructionsForKeys([alt], required)).toEqual([]);
  });

  it('sorts by descending coverage', () => {
    const altA = altWithAddresses([TOKEN, ATA]); // covers 2 of 3
    const altB = altWithAddresses([WSOL]); // covers 1 of 3
    const altC = altWithAddresses([TOKEN]); // covers 1 of 3
    const required = [TOKEN, ATA, WSOL].map((k) => PublicKey.fromBase58(k));
    const result = findInstructionsForKeys([altB, altA, altC], required);
    expect(result.map((r) => r.covered.length)).toEqual([2, 1, 1]);
    expect(result[0]!.alt).toBe(altA);
  });

  it('filters out zero-coverage ALTs', () => {
    const altA = altWithAddresses([USDT]);
    const altB = altWithAddresses([TOKEN, ATA]);
    const required = [PublicKey.fromBase58(TOKEN), PublicKey.fromBase58(ATA)];
    const result = findInstructionsForKeys([altA, altB], required);
    expect(result).toHaveLength(1);
    expect(result[0]!.alt).toBe(altB);
    expect(result[0]!.covered.map((k) => k.toBase58())).toEqual([TOKEN, ATA]);
  });

  it('breaks ties by input order (stable sort)', () => {
    const altA = altWithAddresses([TOKEN]);
    const altB = altWithAddresses([ATA]);
    const required = [PublicKey.fromBase58(TOKEN), PublicKey.fromBase58(ATA)];
    const result = findInstructionsForKeys([altA, altB], required);
    expect(result[0]!.alt).toBe(altA);
    expect(result[1]!.alt).toBe(altB);
  });

  it('handles a required key that appears in multiple ALTs', () => {
    const altA = altWithAddresses([TOKEN, ATA]); // covers 2
    const altB = altWithAddresses([TOKEN]); // covers 1
    const required = [PublicKey.fromBase58(TOKEN), PublicKey.fromBase58(ATA)];
    const result = findInstructionsForKeys([altA, altB], required);
    expect(result[0]!.covered).toHaveLength(2);
    expect(result[1]!.covered).toHaveLength(1);
  });
});
