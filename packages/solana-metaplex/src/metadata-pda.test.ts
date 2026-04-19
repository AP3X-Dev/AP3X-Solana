import { describe, it, expect } from 'vitest';

import { PublicKey } from '@ap3x/solana-core';

import { getMetadataPda, METADATA_PROGRAM_ID } from './metadata-pda';

describe('METADATA_PROGRAM_ID', () => {
  it('is the canonical Metaplex Token Metadata program ID', () => {
    expect(METADATA_PROGRAM_ID.toBase58()).toBe(
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
    );
  });
});

describe('getMetadataPda', () => {
  // Known-good metadata PDAs for well-known mints. Values cross-checked
  // against the canonical `@metaplex-foundation/mpl-token-metadata`
  // derivation (seeds: ["metadata", programId, mint]) and recorded here as
  // the expected outputs. If any of these drift we've broken parity.
  const vectors: Array<{ mint: string; address: string; bump: number }> = [
    {
      // USDC mint
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      address: '5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq',
      bump: 255,
    },
    {
      // wSOL mint
      mint: 'So11111111111111111111111111111111111111112',
      address: '6dM4TqWyWJsbx7obrdLcviBkTafD5E8av61zfU6jq57X',
      bump: 255,
    },
    {
      // USDT mint
      mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      address: '8c3zk1t1qt3RU43ckuvPkCS7HLbjJqq3J3Me8ov4aHrp',
      bump: 255,
    },
  ];

  for (const v of vectors) {
    it(`derives the canonical PDA for mint ${v.mint.slice(0, 8)}…`, () => {
      const mint = PublicKey.fromBase58(v.mint);
      const pda = getMetadataPda(mint);
      expect(pda.address.toBase58()).toBe(v.address);
      expect(pda.bump).toBe(v.bump);
    });
  }

  it('is deterministic — same mint produces the same PDA', () => {
    const mint = PublicKey.fromBase58(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    const a = getMetadataPda(mint);
    const b = getMetadataPda(mint);
    expect(a.address.equals(b.address)).toBe(true);
    expect(a.bump).toBe(b.bump);
  });

  it('produces distinct PDAs for distinct mints', () => {
    const m1 = PublicKey.fromBase58(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    const m2 = PublicKey.fromBase58(
      'So11111111111111111111111111111111111111112',
    );
    const p1 = getMetadataPda(m1);
    const p2 = getMetadataPda(m2);
    expect(p1.address.equals(p2.address)).toBe(false);
  });

  it('returns a bump in the valid u8 range', () => {
    const mint = PublicKey.fromBase58(
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    );
    const pda = getMetadataPda(mint);
    expect(pda.bump).toBeGreaterThanOrEqual(0);
    expect(pda.bump).toBeLessThanOrEqual(255);
  });
});
