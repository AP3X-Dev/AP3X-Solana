import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';

import {
  createAssociatedTokenAccountIx,
  createAssociatedTokenAccountNonIdempotentIx,
  getAssociatedTokenAddress,
} from './ata';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './program-ids';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AtaVector {
  label: string;
  owner: string;
  mint: string;
  tokenProgram: string;
  expectedAddress: string;
  expectedBump: number;
}

const FIXTURES_PATH = resolve(
  __dirname,
  '..',
  'tests',
  'fixtures',
  'ata-vectors.json',
);
const VECTORS = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as AtaVector[];

// A known-off-curve pubkey — derived from an arbitrary PDA seed set so the
// test doesn't depend on any chain constants.
const OFF_CURVE_PUBKEY = findProgramAddress(
  [new TextEncoder().encode('ap3x-test-off-curve')],
  TOKEN_PROGRAM_ID,
).address;

// A known on-curve pubkey — the wSOL mint address is a real ed25519 point.
// This is the simplest way to get an on-curve test vector without a
// keypair.
const ON_CURVE_PUBKEY = PublicKey.fromBase58(
  'So11111111111111111111111111111111111111112',
);

describe('getAssociatedTokenAddress — canonical vectors', () => {
  for (const v of VECTORS) {
    it(`matches fixture: ${v.label}`, () => {
      const owner = PublicKey.fromBase58(v.owner);
      const mint = PublicKey.fromBase58(v.mint);
      const tokenProgramId = PublicKey.fromBase58(v.tokenProgram);
      // Skip the on-curve check — fixtures mix curve-on and curve-off
      // owners, and the derivation itself is curve-agnostic. The
      // dedicated off-curve tests below cover the guard behaviour.
      const ata = getAssociatedTokenAddress(
        mint,
        owner,
        true,
        tokenProgramId,
      );
      expect(ata.toBase58()).toBe(v.expectedAddress);
    });
  }

  it('defaults to TOKEN_PROGRAM_ID when no tokenProgram is given', () => {
    // Pick the first v1 vector whose owner is on-curve (so the default
    // allowOwnerOffCurve=false doesn't reject it). OWNER_A / OWNER_B are
    // on-curve in our set.
    const v = VECTORS.find(
      (x) =>
        x.tokenProgram === TOKEN_PROGRAM_ID.toBase58() &&
        x.owner === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    )!;
    const owner = PublicKey.fromBase58(v.owner);
    const mint = PublicKey.fromBase58(v.mint);
    const withDefault = getAssociatedTokenAddress(mint, owner);
    expect(withDefault.toBase58()).toBe(v.expectedAddress);
  });

  it('produces a different address for Token-2022 vs v1 with the same owner+mint', () => {
    const owner = PublicKey.fromBase58(
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    );
    const mint = PublicKey.fromBase58(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    const v1 = getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID);
    const v22 = getAssociatedTokenAddress(
      mint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    expect(v1.equals(v22)).toBe(false);
  });
});

describe('getAssociatedTokenAddress — off-curve handling', () => {
  it('throws when allowOwnerOffCurve is false and the owner is off-curve', () => {
    expect(() =>
      getAssociatedTokenAddress(ON_CURVE_PUBKEY, OFF_CURVE_PUBKEY),
    ).toThrow(/off-curve/);
  });

  it('succeeds when allowOwnerOffCurve is true and the owner is off-curve', () => {
    const ata = getAssociatedTokenAddress(
      ON_CURVE_PUBKEY,
      OFF_CURVE_PUBKEY,
      true,
    );
    expect(ata).toBeDefined();
    // Sanity: re-derivation with same args should match.
    const again = getAssociatedTokenAddress(
      ON_CURVE_PUBKEY,
      OFF_CURVE_PUBKEY,
      true,
    );
    expect(ata.equals(again)).toBe(true);
  });

  it('succeeds for an on-curve owner with the default allowOwnerOffCurve=false', () => {
    expect(() =>
      getAssociatedTokenAddress(ON_CURVE_PUBKEY, ON_CURVE_PUBKEY),
    ).not.toThrow();
  });
});

describe('createAssociatedTokenAccountIx', () => {
  const payer = PublicKey.fromBase58(
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  );
  const owner = PublicKey.fromBase58(
    'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
  );
  const mint = PublicKey.fromBase58(
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  );

  it('produces a 6-key instruction with the expected ABI order', () => {
    const ix = createAssociatedTokenAccountIx(payer, owner, mint);
    expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(6);

    const expectedAta = getAssociatedTokenAddress(mint, owner, true);

    // Position-by-position checks mirror the Solana ATA program ABI.
    expect(ix.keys[0]!.pubkey.equals(payer)).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(true);

    expect(ix.keys[1]!.pubkey.equals(expectedAta)).toBe(true);
    expect(ix.keys[1]!.isSigner).toBe(false);
    expect(ix.keys[1]!.isWritable).toBe(true);

    expect(ix.keys[2]!.pubkey.equals(owner)).toBe(true);
    expect(ix.keys[2]!.isSigner).toBe(false);
    expect(ix.keys[2]!.isWritable).toBe(false);

    expect(ix.keys[3]!.pubkey.equals(mint)).toBe(true);
    expect(ix.keys[3]!.isSigner).toBe(false);
    expect(ix.keys[3]!.isWritable).toBe(false);

    expect(ix.keys[4]!.pubkey.equals(SYSTEM_PROGRAM_ID)).toBe(true);
    expect(ix.keys[4]!.isSigner).toBe(false);
    expect(ix.keys[4]!.isWritable).toBe(false);

    expect(ix.keys[5]!.pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[5]!.isSigner).toBe(false);
    expect(ix.keys[5]!.isWritable).toBe(false);
  });

  it('emits discriminator byte 1 (CreateIdempotent)', () => {
    const ix = createAssociatedTokenAccountIx(payer, owner, mint);
    expect(Array.from(ix.data)).toEqual([1]);
  });

  it('accepts a custom tokenProgramId (e.g. Token-2022)', () => {
    const ix = createAssociatedTokenAccountIx(
      payer,
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    );
    expect(ix.keys[5]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // The ATA in slot 1 must match the T22-derived address, not v1.
    const expectedAta = getAssociatedTokenAddress(
      mint,
      owner,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    expect(ix.keys[1]!.pubkey.equals(expectedAta)).toBe(true);
  });

  it('permits PDA owners (allowOwnerOffCurve=true under the hood)', () => {
    expect(() =>
      createAssociatedTokenAccountIx(payer, OFF_CURVE_PUBKEY, mint),
    ).not.toThrow();
  });
});

describe('createAssociatedTokenAccountNonIdempotentIx', () => {
  it('emits discriminator byte 0 (Create) with the same key layout', () => {
    const payer = PublicKey.fromBase58(
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    );
    const owner = PublicKey.fromBase58(
      'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH',
    );
    const mint = PublicKey.fromBase58(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    const idem = createAssociatedTokenAccountIx(payer, owner, mint);
    const plain = createAssociatedTokenAccountNonIdempotentIx(
      payer,
      owner,
      mint,
    );
    expect(Array.from(plain.data)).toEqual([0]);
    // Same keys, same programId — the only difference is the discriminator.
    expect(plain.programId.equals(idem.programId)).toBe(true);
    expect(plain.keys).toHaveLength(idem.keys.length);
    for (let i = 0; i < plain.keys.length; i++) {
      expect(plain.keys[i]!.pubkey.equals(idem.keys[i]!.pubkey)).toBe(true);
    }
  });
});
