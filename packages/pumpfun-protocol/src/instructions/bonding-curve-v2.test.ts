import { describe, expect, it } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { PUMP_SCHEMA } from '@ap3x/pumpfun-events';
import { getAssociatedTokenAddress, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@ap3x/solana-spl';
import { buildBuyExactQuoteInV2, buildBuyV2, buildSellV2 } from './bonding-curve.js';
import { deriveBondingCurvePda } from '../curve/state.js';

const key = (n: number) => PublicKey.fromBytes(new Uint8Array(32).fill(n));
const base = {
  baseMint: key(1),
  quoteMint: NATIVE_MINT,
  user: key(2),
  feeRecipient: key(3),
  buybackFeeRecipient: key(4),
  creator: key(5),
  baseTokenProgram: TOKEN_2022_PROGRAM_ID,
};
const ixOf = (name: string) => PUMP_SCHEMA.instructions.find((i) => i.name === name)!;
const u64At = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(at, true);
const disc = (name: string) => ixOf(name).discriminator;
const hex = (d: Uint8Array) => Buffer.from(d.subarray(0, 8)).toString('hex');

describe('v2 bonding-curve builders', () => {
  it.each([
    ['buy_v2', () => buildBuyV2({ ...base, amount: 7n, maxSolCost: 9n }), [7n, 9n]],
    ['buy_exact_quote_in_v2', () => buildBuyExactQuoteInV2({ ...base, spendableQuoteIn: 11n, minTokensOut: 3n }), [11n, 3n]],
    ['sell_v2', () => buildSellV2({ ...base, amount: 13n, minSolOutput: 5n }), [13n, 5n]],
  ] as const)('%s: IDL discriminator, account list and u64 args', (name, build, [a, b]) => {
    const ix = build();
    expect(hex(ix.data)).toBe(disc(name));
    expect(ix.data.length).toBe(24);
    expect(u64At(ix.data, 8)).toBe(a);
    expect(u64At(ix.data, 16)).toBe(b);
    const accounts = ixOf(name).accounts;
    expect(ix.keys).toHaveLength(accounts.length);
    ix.keys.forEach((k, i) => {
      expect(k.isSigner).toBe(accounts[i]!.signer);
      expect(k.isWritable).toBe(accounts[i]!.writable);
    });
    const at = (n: string) => ix.keys[accounts.findIndex((x) => x.name === n)]!.pubkey.toBase58();
    expect(at('base_mint')).toBe(base.baseMint.toBase58());
    expect(at('quote_mint')).toBe(NATIVE_MINT.toBase58());
    expect(at('bonding_curve')).toBe(deriveBondingCurvePda(base.baseMint).address.toBase58());
    expect(at('associated_base_user')).toBe(getAssociatedTokenAddress(base.baseMint, base.user, true, TOKEN_2022_PROGRAM_ID).toBase58());
    expect(at('associated_quote_user')).toBe(getAssociatedTokenAddress(NATIVE_MINT, base.user, true, TOKEN_PROGRAM_ID).toBase58());
    expect(at('user')).toBe(base.user.toBase58());
  });

  it('rejects zero amounts', () => {
    expect(() => buildBuyV2({ ...base, amount: 0n, maxSolCost: 1n })).toThrow();
    expect(() => buildBuyV2({ ...base, amount: 1n, maxSolCost: 0n })).toThrow();
    expect(() => buildBuyExactQuoteInV2({ ...base, spendableQuoteIn: 0n, minTokensOut: 1n })).toThrow();
    expect(() => buildSellV2({ ...base, amount: 0n, minSolOutput: 0n })).toThrow();
  });

  it('honours explicit user token accounts', () => {
    const ix = buildSellV2({ ...base, amount: 1n, minSolOutput: 0n, userBaseTokenAccount: key(8), userQuoteTokenAccount: key(9) });
    const names = ixOf('sell_v2').accounts.map((a) => a.name);
    expect(ix.keys[names.indexOf('associated_base_user')]!.pubkey.equals(key(8))).toBe(true);
    expect(ix.keys[names.indexOf('associated_quote_user')]!.pubkey.equals(key(9))).toBe(true);
  });
});
