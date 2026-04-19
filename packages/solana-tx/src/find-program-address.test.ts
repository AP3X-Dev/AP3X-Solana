import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

import { PublicKey } from '@ap3x/solana-core';

import { findProgramAddress } from './find-program-address';

// ESM-safe `__dirname`.
const __dirname = dirname(fileURLToPath(import.meta.url));

interface SeedSpec {
  type: 'pubkey-base58' | 'utf8' | 'hex';
  value: string;
}
interface Vector {
  label: string;
  seeds: SeedSpec[];
  programId: string;
  expectedAddress: string;
  expectedBump: number;
}

const vectorsPath = resolve(__dirname, '..', 'tests', 'fixtures', 'pdas.json');
const VECTORS = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vector[];

function decodeHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function materializeSeed(s: SeedSpec): Uint8Array {
  switch (s.type) {
    case 'pubkey-base58':
      return PublicKey.fromBase58(s.value).toBuffer();
    case 'utf8':
      return new TextEncoder().encode(s.value);
    case 'hex':
      return decodeHex(s.value);
  }
}

describe('findProgramAddress — fixture parity', () => {
  it('has at least 20 committed vectors', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20);
  });

  for (const v of VECTORS) {
    it(`derives ${v.label} with bump ${v.expectedBump}`, () => {
      const seeds = v.seeds.map(materializeSeed);
      const programId = PublicKey.fromBase58(v.programId);
      const { address, bump } = findProgramAddress(seeds, programId);
      expect(bump).toBe(v.expectedBump);
      expect(address.toBase58()).toBe(v.expectedAddress);
    });
  }
});

describe('findProgramAddress — determinism', () => {
  it('produces identical output for repeated calls with the same input', () => {
    const seeds = [new TextEncoder().encode('determinism-test')];
    const programId = PublicKey.fromBase58('11111111111111111111111111111111');
    const a = findProgramAddress(seeds, programId);
    const b = findProgramAddress(seeds, programId);
    expect(a.bump).toBe(b.bump);
    expect(a.address.equals(b.address)).toBe(true);
  });

  it('produces distinct output for distinct seeds', () => {
    const programId = PublicKey.fromBase58('11111111111111111111111111111111');
    const a = findProgramAddress([new TextEncoder().encode('seed-a')], programId);
    const b = findProgramAddress([new TextEncoder().encode('seed-b')], programId);
    expect(a.address.equals(b.address)).toBe(false);
  });

  it('produces distinct output for distinct programIds', () => {
    const seed = [new TextEncoder().encode('shared')];
    const a = findProgramAddress(seed, PublicKey.fromBase58('11111111111111111111111111111111'));
    const b = findProgramAddress(seed, PublicKey.fromBase58('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
    expect(a.address.equals(b.address)).toBe(false);
  });

  it('derived bump is in [0, 255]', () => {
    for (const v of VECTORS) {
      expect(v.expectedBump).toBeGreaterThanOrEqual(0);
      expect(v.expectedBump).toBeLessThanOrEqual(255);
    }
  });
});

describe('findProgramAddress — sha512 wiring', () => {
  // Importing `find-program-address` installs ed25519's sha512 hasher. The
  // Solana PDA algorithm itself doesn't hit the async path, but downstream
  // substrate code (vault signing, bundlers) relies on both sync AND async
  // hashers being usable after this module imports — so we test both here
  // to lock in the contract.
  it('installs sha512Sync that matches @noble/hashes output', () => {
    const out = ed.etc.sha512Sync!(new Uint8Array([1, 2, 3]));
    const expected = sha512(new Uint8Array([1, 2, 3]));
    expect(out).toEqual(expected);
  });

  it('installs sha512Async that matches @noble/hashes output', async () => {
    const out = await ed.etc.sha512Async(new Uint8Array([1, 2, 3]));
    const expected = sha512(new Uint8Array([1, 2, 3]));
    expect(out).toEqual(expected);
  });
});

describe('findProgramAddress — input validation', () => {
  const programId = PublicKey.fromBase58('11111111111111111111111111111111');

  it('throws when too many seeds are supplied', () => {
    const seeds: Uint8Array[] = [];
    for (let i = 0; i < 17; i++) seeds.push(new Uint8Array([i]));
    expect(() => findProgramAddress(seeds, programId)).toThrow(/too many seeds/);
  });

  it('accepts exactly 16 seeds', () => {
    const seeds: Uint8Array[] = [];
    for (let i = 0; i < 16; i++) seeds.push(new Uint8Array([i]));
    // Should not throw input-validation; derivation itself may iterate bumps
    // but the result always exists for real inputs.
    const { address, bump } = findProgramAddress(seeds, programId);
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
  });

  it('throws when a seed exceeds 32 bytes', () => {
    const seeds = [new Uint8Array(33)];
    expect(() => findProgramAddress(seeds, programId)).toThrow(/exceeds max 32/);
  });

  it('accepts a seed of exactly 32 bytes', () => {
    const seeds = [new Uint8Array(32).fill(0x42)];
    const { address } = findProgramAddress(seeds, programId);
    expect(address).toBeInstanceOf(PublicKey);
  });

  it('accepts an empty seed array', () => {
    const { address, bump } = findProgramAddress([], programId);
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
  });

  it('reports the offending seed index in the error', () => {
    const seeds = [new Uint8Array(10), new Uint8Array(33)];
    expect(() => findProgramAddress(seeds, programId)).toThrow(/seed\[1\]/);
  });
});
