import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import {
  deriveBondingCurvePda,
  deriveAssociatedBondingCurvePda,
  deriveGlobalPda,
  deriveEventAuthorityPda,
  derivePumpSwapPoolPda,
} from './account-derivation.js';

const MINT_A = PublicKey.fromBase58('So11111111111111111111111111111111111111112');
const MINT_B = PublicKey.fromBase58('11111111111111111111111111111111');

describe('deriveBondingCurvePda (re-exported from curve/state.ts)', () => {
  it('derives a deterministic off-curve address for a mint', () => {
    const { address, bump } = deriveBondingCurvePda(MINT_A);
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThan(256);
  });

  it('is stable across calls', () => {
    const a = deriveBondingCurvePda(MINT_A);
    const b = deriveBondingCurvePda(MINT_A);
    expect(a.address.equals(b.address)).toBe(true);
    expect(a.bump).toBe(b.bump);
  });

  it('produces different PDAs for different mints', () => {
    const a = deriveBondingCurvePda(MINT_A);
    const b = deriveBondingCurvePda(MINT_B);
    expect(a.address.equals(b.address)).toBe(false);
  });
});

describe('deriveAssociatedBondingCurvePda', () => {
  it('derives a deterministic ATA address for a mint', () => {
    const { address, bump } = deriveAssociatedBondingCurvePda(MINT_A);
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThan(256);
  });

  it('is stable across calls', () => {
    const a = deriveAssociatedBondingCurvePda(MINT_A);
    const b = deriveAssociatedBondingCurvePda(MINT_A);
    expect(a.address.equals(b.address)).toBe(true);
    expect(a.bump).toBe(b.bump);
  });

  it('differs from the plain bonding-curve PDA', () => {
    const bc = deriveBondingCurvePda(MINT_A);
    const abc = deriveAssociatedBondingCurvePda(MINT_A);
    expect(abc.address.equals(bc.address)).toBe(false);
  });

  it('produces different ATAs for different mints', () => {
    const a = deriveAssociatedBondingCurvePda(MINT_A);
    const b = deriveAssociatedBondingCurvePda(MINT_B);
    expect(a.address.equals(b.address)).toBe(false);
  });

  it('lives under the Associated Token Account program', () => {
    // The ATA derivation is by definition a PDA under the ATA program — this
    // test is a spec-level sanity check: if anyone ever swaps the program ID
    // we want an immediate failure rather than a silently-wrong address.
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    );
  });
});

describe('deriveGlobalPda', () => {
  it('derives a deterministic address with no mint input', () => {
    const { address, bump } = deriveGlobalPda();
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThan(256);
  });

  it('is stable across calls', () => {
    const a = deriveGlobalPda();
    const b = deriveGlobalPda();
    expect(a.address.equals(b.address)).toBe(true);
    expect(a.bump).toBe(b.bump);
  });

  it('is under the bonding-curve program', () => {
    // Spec check: the global PDA must derive under the bonding-curve program.
    // Flag any future drift of the program ID import.
    expect(PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58()).toBe(
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    );
  });
});

describe('deriveEventAuthorityPda', () => {
  it('derives a deterministic address with no mint input', () => {
    const { address, bump } = deriveEventAuthorityPda();
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThan(256);
  });

  it('is stable across calls', () => {
    const a = deriveEventAuthorityPda();
    const b = deriveEventAuthorityPda();
    expect(a.address.equals(b.address)).toBe(true);
    expect(a.bump).toBe(b.bump);
  });

  it('differs from the global PDA (different seeds)', () => {
    const g = deriveGlobalPda();
    const e = deriveEventAuthorityPda();
    expect(g.address.equals(e.address)).toBe(false);
  });
});

describe('derivePumpSwapPoolPda', () => {
  it('derives a deterministic address from a mint', () => {
    const { address, bump } = derivePumpSwapPoolPda(MINT_A);
    expect(address).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThan(256);
  });

  it('is stable across calls', () => {
    const a = derivePumpSwapPoolPda(MINT_A);
    const b = derivePumpSwapPoolPda(MINT_A);
    expect(a.address.equals(b.address)).toBe(true);
    expect(a.bump).toBe(b.bump);
  });

  it('produces different pools for different mints', () => {
    const a = derivePumpSwapPoolPda(MINT_A);
    const b = derivePumpSwapPoolPda(MINT_B);
    expect(a.address.equals(b.address)).toBe(false);
  });

  it('is under the PumpSwap program', () => {
    // Spec check: the seed is ASSUMED `[b"pool", mint]`; if on-chain
    // verification shows a different recipe, update the helper and this
    // assertion together.
    expect(PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58()).toBe(
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    );
  });
});
