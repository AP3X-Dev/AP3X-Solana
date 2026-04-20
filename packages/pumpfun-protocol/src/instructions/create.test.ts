/**
 * Shape-only unit tests for {@link buildCreate}.
 *
 * These tests verify the static contract — return type, validation errors,
 * discriminator bytes, Borsh length prefixes — without touching the
 * network. They are not authoritative for the *semantic* correctness of the
 * account layout or the mint-authority PDA seed. See the file-top comment
 * in `create.ts` for the best-effort assumptions that need mainnet
 * confirmation once a Helius API key is available.
 *
 * The `describe.skipIf(!process.env.DEVNET_PAYER_KEY)` block at the bottom
 * holds the skeleton for the live devnet roundtrip test. It stays
 * `skipIf`-gated (not deleted) so the wiring is already in place when the
 * devnet runner (BP2 in the PRP backlog) comes online; until then, the
 * block is skipped on every developer machine and in CI unless
 * `DEVNET_PAYER_KEY` is explicitly set.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@ap3x/solana-core';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import { buildCreate } from './create.js';

const MINT = PublicKey.fromBase58('So11111111111111111111111111111111111111112');
// Distinct fake payer/creator pubkey — `11...11` is the System Program and
// doesn't make a sensible signer; using a different all-ones key keeps the
// test data obviously synthetic but valid.
const PAYER = PublicKey.fromBase58('11111111111111111111111111111112');

describe('buildCreate — shape', () => {
  it('returns an Instruction targeting the bonding-curve program', () => {
    const ix = buildCreate({
      mint: MINT,
      payer: PAYER,
      creator: PAYER,
      name: 'Test',
      symbol: 'TST',
      uri: 'https://example.com/t.json',
    });
    expect(ix.programId.equals(PUMPFUN_BONDING_CURVE_PROGRAM_ID)).toBe(true);
    expect(Array.isArray(ix.keys)).toBe(true);
    expect(ix.keys.length).toBeGreaterThanOrEqual(10);
    // Discriminator (8 bytes) + 3 Borsh strings, each prefixed with u32 LE
    // length (4 bytes), so the minimum possible data length is 8 + 3*4 = 20.
    expect(ix.data.length).toBeGreaterThan(8);
  });

  it('marks payer and mint as signers', () => {
    const ix = buildCreate({
      mint: MINT,
      payer: PAYER,
      creator: PAYER,
      name: 'Test',
      symbol: 'TST',
      uri: 'x',
    });
    // Payer at index 0 signs; mint at index 1 signs (fresh keypair). Both
    // are writable because rent lamports flow into both accounts.
    const payerMeta = ix.keys[0];
    const mintMeta = ix.keys[1];
    if (!payerMeta || !mintMeta) throw new Error('expected at least two keys');
    expect(payerMeta.isSigner).toBe(true);
    expect(payerMeta.isWritable).toBe(true);
    expect(mintMeta.isSigner).toBe(true);
    expect(mintMeta.isWritable).toBe(true);
    // Every other account is a non-signer.
    for (let i = 2; i < ix.keys.length; i++) {
      const meta = ix.keys[i];
      if (!meta) throw new Error(`missing key at index ${i}`);
      expect(meta.isSigner).toBe(false);
    }
  });

  it('rejects empty name', () => {
    expect(() =>
      buildCreate({
        mint: MINT,
        payer: PAYER,
        creator: PAYER,
        name: '',
        symbol: 'TST',
        uri: 'x',
      }),
    ).toThrow(TypeError);
  });

  it('rejects name longer than 64 chars', () => {
    expect(() =>
      buildCreate({
        mint: MINT,
        payer: PAYER,
        creator: PAYER,
        name: 'A'.repeat(65),
        symbol: 'TST',
        uri: 'x',
      }),
    ).toThrow(TypeError);
  });

  it('rejects empty symbol', () => {
    expect(() =>
      buildCreate({
        mint: MINT,
        payer: PAYER,
        creator: PAYER,
        name: 'Valid',
        symbol: '',
        uri: 'x',
      }),
    ).toThrow(TypeError);
  });

  it('rejects symbol longer than 16 chars', () => {
    expect(() =>
      buildCreate({
        mint: MINT,
        payer: PAYER,
        creator: PAYER,
        name: 'Valid',
        symbol: 'A'.repeat(17),
        uri: 'x',
      }),
    ).toThrow(TypeError);
  });

  it('encodes discriminator + name/symbol/uri with Borsh length prefixes', () => {
    const name = 'Hello';
    const symbol = 'HEL';
    const uri = 'ipfs://qm...';
    const ix = buildCreate({
      mint: MINT,
      payer: PAYER,
      creator: PAYER,
      name,
      symbol,
      uri,
    });

    // First 8 bytes: Anchor discriminator for `sha256("global:create")[..8]`
    // == `18 1e c8 28 05 1c 07 77` (matches `INSTRUCTION_DISCRIMINATORS.create`).
    expect(Array.from(ix.data.slice(0, 8))).toEqual([
      0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77,
    ]);

    // name: u32 LE length + UTF-8 bytes
    let offset = 8;
    expect(Array.from(ix.data.slice(offset, offset + 4))).toEqual([
      name.length, 0, 0, 0,
    ]);
    expect(
      new TextDecoder().decode(ix.data.slice(offset + 4, offset + 4 + name.length)),
    ).toBe(name);
    offset += 4 + name.length;

    // symbol
    expect(Array.from(ix.data.slice(offset, offset + 4))).toEqual([
      symbol.length, 0, 0, 0,
    ]);
    expect(
      new TextDecoder().decode(
        ix.data.slice(offset + 4, offset + 4 + symbol.length),
      ),
    ).toBe(symbol);
    offset += 4 + symbol.length;

    // uri
    expect(Array.from(ix.data.slice(offset, offset + 4))).toEqual([
      uri.length, 0, 0, 0,
    ]);
    expect(
      new TextDecoder().decode(ix.data.slice(offset + 4, offset + 4 + uri.length)),
    ).toBe(uri);
    offset += 4 + uri.length;

    // All fields fully consumed — no trailing bytes.
    expect(offset).toBe(ix.data.length);
  });

  it('derives the same instruction for the same params (deterministic)', () => {
    const params = {
      mint: MINT,
      payer: PAYER,
      creator: PAYER,
      name: 'Det',
      symbol: 'D',
      uri: 'u',
    };
    const a = buildCreate(params);
    const b = buildCreate(params);
    expect(a.keys.length).toBe(b.keys.length);
    for (let i = 0; i < a.keys.length; i++) {
      const ka = a.keys[i];
      const kb = b.keys[i];
      if (!ka || !kb) throw new Error(`missing key at index ${i}`);
      expect(ka.pubkey.equals(kb.pubkey)).toBe(true);
      expect(ka.isSigner).toBe(kb.isSigner);
      expect(ka.isWritable).toBe(kb.isWritable);
    }
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

// ----------------------------------------------------------------------------
// Live devnet roundtrip — skeleton only.
//
// Stays `skipIf`-gated pending BP2 in the PRP backlog: the generic devnet
// runner (assemble → simulate → decode → assert) is not wired yet. The
// structure is here so once that runner lands, the body is a simple fill-in.
// Until then, this block skips unconditionally on every developer machine
// and in CI (`DEVNET_PAYER_KEY` is never set). Do not delete.
// ----------------------------------------------------------------------------
describe.skipIf(!process.env.DEVNET_PAYER_KEY)(
  'buildCreate — devnet roundtrip (skipped until BP2 runner lands)',
  () => {
    it('assembles, simulates, and decodes a CreateEvent from the logs', async () => {
      // TODO (BP2): wire devnet runner.
      //   1. Parse DEVNET_PAYER_KEY → WalletHandle via `@ap3x/solana-vault`.
      //   2. Generate a fresh mint keypair.
      //   3. Build the instruction via `buildCreate`.
      //   4. `assemble({ payer, signers: [payerWallet, mintKeypair], instructions: [ix], ... })`.
      //   5. `rpc.simulateTransaction(signed)` on devnet.
      //   6. Run `bondingCurveDecoder.decode` over the returned logs.
      //   7. Assert the decoded `Create` event has the same name/symbol/uri.
      expect(true).toBe(true);
    });
  },
);
