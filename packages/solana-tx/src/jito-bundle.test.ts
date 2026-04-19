import { describe, it, expect } from 'vitest';

import { PublicKey, Ap3xError } from '@ap3x/solana-core';

import {
  JitoBundleBuilder,
  JITO_MAX_TXS_PER_BUNDLE,
  SYSTEM_PROGRAM_ID,
  type Bundle,
} from './jito-bundle';
import type { Instruction } from './transaction-assembler';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Fake signed transaction bytes — content doesn't matter for bundle framing. */
function fakeSignedTx(seed: number, length = 128): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

/** Deterministic 32-byte pubkey with a single non-zero byte at position 0. */
function fakePubkey(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed & 0xff;
  bytes[1] = (seed >> 8) & 0xff;
  return PublicKey.fromBytes(bytes);
}

// ---------------------------------------------------------------------------
// compose()
// ---------------------------------------------------------------------------

describe('JitoBundleBuilder.compose', () => {
  it('accepts a single transaction', () => {
    const builder = new JitoBundleBuilder();
    const tx1 = fakeSignedTx(1);
    const bundle: Bundle = builder.compose([tx1]);
    expect(bundle.transactions).toHaveLength(1);
    expect(bundle.transactions[0]).toBe(tx1);
  });

  it('accepts up to 5 signed transactions', () => {
    const builder = new JitoBundleBuilder();
    const txs = [
      fakeSignedTx(1),
      fakeSignedTx(2),
      fakeSignedTx(3),
      fakeSignedTx(4),
      fakeSignedTx(5),
    ];
    const bundle = builder.compose(txs);
    expect(bundle.transactions).toHaveLength(JITO_MAX_TXS_PER_BUNDLE);
    expect(bundle.transactions).toEqual(txs);
  });

  it('throws if more than 5 transactions are provided', () => {
    const builder = new JitoBundleBuilder();
    const txs = [
      fakeSignedTx(1),
      fakeSignedTx(2),
      fakeSignedTx(3),
      fakeSignedTx(4),
      fakeSignedTx(5),
      fakeSignedTx(6),
    ];
    expect(() => builder.compose(txs)).toThrowError(/exceeds.*limit.*5/i);
  });

  it('throws on an empty bundle', () => {
    const builder = new JitoBundleBuilder();
    expect(() => builder.compose([])).toThrowError(/at least one/i);
  });

  it('returns a shallow-copied transactions array (mutating output does not affect input)', () => {
    const builder = new JitoBundleBuilder();
    const tx1 = fakeSignedTx(1);
    const tx2 = fakeSignedTx(2);
    const input = [tx1, tx2];
    const bundle = builder.compose(input);
    bundle.transactions.push(fakeSignedTx(3));
    expect(input).toHaveLength(2);
    // And mutating the input array should not affect the bundle.
    input.push(fakeSignedTx(4));
    expect(bundle.transactions).toHaveLength(3);
  });

  it('thrown errors are Ap3xError instances (substrate error hierarchy)', () => {
    const builder = new JitoBundleBuilder();
    try {
      builder.compose([
        fakeSignedTx(1),
        fakeSignedTx(2),
        fakeSignedTx(3),
        fakeSignedTx(4),
        fakeSignedTx(5),
        fakeSignedTx(6),
      ]);
      throw new Error('expected compose to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Ap3xError);
    }
  });
});

// ---------------------------------------------------------------------------
// tipInstruction()
// ---------------------------------------------------------------------------

describe('JitoBundleBuilder.tipInstruction', () => {
  it('returns a SystemProgram transfer instruction with the expected shape', () => {
    const builder = new JitoBundleBuilder();
    const from = fakePubkey(1);
    const tipAccount = fakePubkey(2);
    const lamports = 10_000n;

    const ix: Instruction = builder.tipInstruction(from, tipAccount, lamports);

    // programId = System Program
    expect(ix.programId.toBase58()).toBe(SYSTEM_PROGRAM_ID.toBase58());
    expect(ix.programId.toBase58()).toBe('11111111111111111111111111111111');

    // keys = [{from, signer, writable}, {tipAccount, not-signer, writable}]
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0]).toEqual({
      pubkey: from,
      isSigner: true,
      isWritable: true,
    });
    expect(ix.keys[1]).toEqual({
      pubkey: tipAccount,
      isSigner: false,
      isWritable: true,
    });
  });

  it('encodes data as [discriminator u32 = 2][lamports u64 LE] — 12 bytes total', () => {
    const builder = new JitoBundleBuilder();
    const from = fakePubkey(1);
    const tipAccount = fakePubkey(2);
    const lamports = 10_000n;

    const ix = builder.tipInstruction(from, tipAccount, lamports);

    expect(ix.data).toBeInstanceOf(Uint8Array);
    expect(ix.data.byteLength).toBe(12);

    // Verify discriminator: first 4 bytes little-endian = 2 (Transfer).
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    expect(view.getUint32(0, true)).toBe(2);

    // Verify lamports: next 8 bytes little-endian = 10_000.
    expect(view.getBigUint64(4, true)).toBe(10_000n);
  });

  it('encodes large u64 lamports values correctly (up to max u64)', () => {
    const builder = new JitoBundleBuilder();
    const from = fakePubkey(1);
    const tipAccount = fakePubkey(2);
    const lamports = 18_446_744_073_709_551_615n; // 2^64 - 1

    const ix = builder.tipInstruction(from, tipAccount, lamports);
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    expect(view.getBigUint64(4, true)).toBe(lamports);
  });

  it('throws on zero lamports (defensive — a tip must be positive)', () => {
    const builder = new JitoBundleBuilder();
    const from = fakePubkey(1);
    const tipAccount = fakePubkey(2);
    expect(() => builder.tipInstruction(from, tipAccount, 0n)).toThrowError(
      /positive/i,
    );
  });

  it('throws on negative lamports', () => {
    const builder = new JitoBundleBuilder();
    const from = fakePubkey(1);
    const tipAccount = fakePubkey(2);
    expect(() => builder.tipInstruction(from, tipAccount, -1n)).toThrowError(
      /positive/i,
    );
  });

  it('thrown errors are Ap3xError instances', () => {
    const builder = new JitoBundleBuilder();
    const from = fakePubkey(1);
    const tipAccount = fakePubkey(2);
    try {
      builder.tipInstruction(from, tipAccount, 0n);
      throw new Error('expected tipInstruction to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Ap3xError);
    }
  });

  it('SYSTEM_PROGRAM_ID exported constant matches canonical all-zeros pubkey', () => {
    expect(SYSTEM_PROGRAM_ID.toBase58()).toBe('11111111111111111111111111111111');
    const bytes = SYSTEM_PROGRAM_ID.toBuffer();
    expect(bytes).toHaveLength(32);
    for (let i = 0; i < 32; i++) {
      expect(bytes[i]).toBe(0);
    }
  });

  it('JITO_MAX_TXS_PER_BUNDLE is 5 (Jito protocol limit)', () => {
    expect(JITO_MAX_TXS_PER_BUNDLE).toBe(5);
  });
});
