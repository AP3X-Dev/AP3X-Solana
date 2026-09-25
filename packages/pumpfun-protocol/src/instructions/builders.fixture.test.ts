import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import type { Instruction } from '@ap3x/solana-tx';
import { PUMP_AMM_SCHEMA, PUMP_SCHEMA, PUMPFUN_PUMPSWAP_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { decodeCurveState } from '../curve/state.js';
import { decodePumpSwapPool } from '../pumpswap/pool-state.js';
import { buildBuy, buildBuyExactSolIn, buildCreate, buildSell } from './bonding-curve.js';
import {
  deriveBondingCurvePda,
  deriveCoinCreatorVaultAuthorityPda,
  deriveCreatorVaultPda,
  deriveEventAuthorityPda,
  deriveUserVolumeAccumulatorPda,
} from './account-derivation.js';
import { buildPumpSwapBuy, buildPumpSwapBuyExactQuoteIn, buildPumpSwapSell } from './pumpswap.js';

/**
 * Rebuilds real mainnet instructions (captured by
 * tests/helpers/capture/capture-pumpfun-instructions.ts) from the same inputs
 * and requires the program-visible result to match: identical data, the same
 * accounts in the same order, and every account the builder marks writable
 * writable in the real transaction (the transaction can mark more, since other
 * instructions in it may write the same account).
 */

interface Fixture {
  program: 'pump' | 'pumpAmm';
  name: string;
  signature: string;
  data: string;
  accounts: string[];
  writable: boolean[];
  stateAccount: { address: string; data: string };
}

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../tests/fixtures/pumpfun-instructions.json', import.meta.url)), 'utf8'),
) as Fixture[];

const SCHEMAS = { pump: PUMP_SCHEMA, pumpAmm: PUMP_AMM_SCHEMA };
const pk = (s: string) => PublicKey.fromBase58(s);
const u64 = (data: Uint8Array, at: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);

function expectMatches(built: Instruction, f: Fixture): void {
  // Discriminator + both u64 amounts must match exactly. The optional
  // `track_volume` flag after them is encoded differently by different
  // clients on mainnet (1 byte per the IDL, 2 bytes, or omitted — the program
  // ignores trailing bytes and defaults a missing flag), so it is not compared.
  expect(Buffer.from(built.data.subarray(0, 24)).toString('hex')).toBe(f.data.slice(0, 48));
  expect(built.keys.map((k) => k.pubkey.toBase58())).toEqual(f.accounts);
  const idlCount = SCHEMAS[f.program].instructions.find((i) => i.name === f.name)!.accounts.length;
  built.keys.forEach((k, i) => {
    if (i >= idlCount) {
      // Trailing accounts are set by hand, not from the IDL: their flags must
      // match the real transaction exactly.
      expect(k.isWritable, `trailing account ${i} (${f.accounts[i]}) writable`).toBe(f.writable[i]);
    } else if (k.isWritable) {
      expect(f.writable[i], `account ${i} (${f.accounts[i]}) writable`).toBe(true);
    }
  });
}

function fixture(program: Fixture['program'], name: string): Fixture {
  const f = fixtures.find((x) => x.program === program && x.name === name);
  if (!f) throw new Error(`no fixture for ${program}:${name} — run pnpm capture:pumpfun-instructions`);
  return f;
}

describe('bonding-curve builders reproduce real mainnet instructions', () => {
  const inputs = (f: Fixture) => {
    const a = f.accounts;
    const data = Buffer.from(f.data, 'hex');
    const curve = decodeCurveState(Buffer.from(f.stateAccount.data, 'base64'), pk(a[2]!));
    const tokenProgramIndex = f.name === 'sell' ? 9 : 8;
    return {
      data,
      curve,
      common: {
        mint: pk(a[2]!),
        user: pk(a[6]!),
        feeRecipient: pk(a[1]!),
        creator: curve.creator,
        buybackFeeRecipient: pk(a[a.length - 1]!),
        tokenProgram: pk(a[tokenProgramIndex]!),
        userTokenAccount: pk(a[5]!),
      },
    };
  };

  it('buy', () => {
    const f = fixture('pump', 'buy');
    const { data, common } = inputs(f);
    expectMatches(
      buildBuy({ ...common, amount: u64(data, 8), maxSolCost: u64(data, 16), trackVolume: data[24] === 1 }),
      f,
    );
  });

  it('buy_exact_sol_in', () => {
    const f = fixture('pump', 'buy_exact_sol_in');
    const { data, common } = inputs(f);
    expectMatches(
      buildBuyExactSolIn({
        ...common,
        spendableSolIn: u64(data, 8),
        minTokensOut: u64(data, 16),
        trackVolume: data[24] === 1,
      }),
      f,
    );
  });

  it('sell', () => {
    const f = fixture('pump', 'sell');
    const { data, common, curve } = inputs(f);
    expectMatches(
      buildSell({ ...common, amount: u64(data, 8), minSolOutput: u64(data, 16), cashback: curve.isCashbackCoin }),
      f,
    );
  });
});

describe('builders accept program-owned (off-curve) users', () => {
  it('derives the default token account for a PDA user', () => {
    const f = fixture('pump', 'buy_exact_sol_in');
    const pda = pk('BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s'); // a real off-curve trader
    const ix = buildBuyExactSolIn({
      mint: pk(f.accounts[2]!),
      user: pda,
      feeRecipient: pk(f.accounts[1]!),
      creator: pk(f.accounts[0]!),
      buybackFeeRecipient: pk(f.accounts[f.accounts.length - 1]!),
      spendableSolIn: 1n,
      minTokensOut: 0n,
    });
    expect(ix.keys[6]!.pubkey.equals(pda)).toBe(true);
  });
});

describe('PumpSwap builders reproduce real mainnet instructions', () => {
  const inputs = (f: Fixture) => {
    const a = f.accounts;
    const pool = decodePumpSwapPool(Buffer.from(f.stateAccount.data, 'base64'), pk(a[0]!));
    return {
      data: Buffer.from(f.data, 'hex'),
      common: {
        pool,
        user: pk(a[1]!),
        protocolFeeRecipient: pk(a[9]!),
        buybackFeeRecipient: pk(a[a.length - 2]!),
        baseTokenProgram: pk(a[11]!),
        quoteTokenProgram: pk(a[12]!),
        userBaseTokenAccount: pk(a[5]!),
        userQuoteTokenAccount: pk(a[6]!),
      },
    };
  };

  it('buy', () => {
    const f = fixture('pumpAmm', 'buy');
    const { data, common } = inputs(f);
    expectMatches(
      buildPumpSwapBuy({
        ...common,
        baseAmountOut: u64(data, 8),
        maxQuoteAmountIn: u64(data, 16),
        trackVolume: data[24] === 1,
      }),
      f,
    );
  });

  it('buy_exact_quote_in', () => {
    const f = fixture('pumpAmm', 'buy_exact_quote_in');
    const { data, common } = inputs(f);
    expectMatches(
      buildPumpSwapBuyExactQuoteIn({
        ...common,
        spendableQuoteIn: u64(data, 8),
        minBaseAmountOut: u64(data, 16),
        trackVolume: data[24] === 1,
      }),
      f,
    );
  });

  it('sell', () => {
    const f = fixture('pumpAmm', 'sell');
    const { data, common } = inputs(f);
    expectMatches(
      buildPumpSwapSell({ ...common, baseAmountIn: u64(data, 8), minQuoteAmountOut: u64(data, 16) }),
      f,
    );
  });
});

describe('derivation helpers match the accounts in real instructions', () => {
  it('creator vault and user volume accumulator (bonding curve)', () => {
    const f = fixture('pump', 'buy');
    const curve = decodeCurveState(Buffer.from(f.stateAccount.data, 'base64'), pk(f.accounts[2]!));
    expect(deriveCreatorVaultPda(curve.creator).address.toBase58()).toBe(f.accounts[9]);
    expect(deriveUserVolumeAccumulatorPda(pk(f.accounts[6]!)).address.toBase58()).toBe(f.accounts[13]);
    expect(deriveEventAuthorityPda().address.toBase58()).toBe(f.accounts[10]);
  });

  it('coin creator vault authority and user volume accumulator (PumpSwap)', () => {
    const f = fixture('pumpAmm', 'buy');
    const pool = decodePumpSwapPool(Buffer.from(f.stateAccount.data, 'base64'), pk(f.accounts[0]!));
    expect(deriveCoinCreatorVaultAuthorityPda(pool.coinCreator).address.toBase58()).toBe(f.accounts[18]);
    expect(deriveUserVolumeAccumulatorPda(pk(f.accounts[1]!), PUMPFUN_PUMPSWAP_PROGRAM_ID).address.toBase58()).toBe(f.accounts[20]);
    expect(deriveEventAuthorityPda(PUMPFUN_PUMPSWAP_PROGRAM_ID).address.toBase58()).toBe(f.accounts[15]);
  });
});

describe('buildCreate', () => {
  const mint = pk('So11111111111111111111111111111111111111112');
  const payer = pk('11111111111111111111111111111112');
  const base = { mint, payer, creator: payer, name: 'Name', symbol: 'SYM', uri: 'https://x' };

  it('puts the mint first and the payer as user, both signing', () => {
    const ix = buildCreate(base);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[0]!.pubkey.equals(mint)).toBe(true);
    expect(ix.keys[7]!.pubkey.equals(payer)).toBe(true);
    expect(ix.keys[7]!.isSigner).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(deriveBondingCurvePda(mint).address)).toBe(true);
    // disc + name + symbol + uri + creator
    expect(ix.data.length).toBe(8 + (4 + 4) + (4 + 3) + (4 + 9) + 32);
  });

  it('validates name and symbol length', () => {
    expect(() => buildCreate({ ...base, name: '' })).toThrow(/name/);
    expect(() => buildCreate({ ...base, symbol: 'X'.repeat(17) })).toThrow(/symbol/);
  });

  it('rejects non-positive trade amounts', () => {
    const f = fixture('pump', 'sell');
    const common = {
      mint: pk(f.accounts[2]!),
      user: pk(f.accounts[6]!),
      feeRecipient: pk(f.accounts[1]!),
      creator: pk(f.accounts[0]!),
      buybackFeeRecipient: pk(f.accounts[f.accounts.length - 1]!),
    };
    expect(() => buildSell({ ...common, amount: 0n, minSolOutput: 0n })).toThrow(/> 0/);
    expect(() => buildBuy({ ...common, amount: 1n, maxSolCost: 0n })).toThrow(/> 0/);
  });
});
