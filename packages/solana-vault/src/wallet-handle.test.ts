import { describe, expect, it, beforeAll, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import { PublicKey } from '@ap3x/solana-core';

import { WalletHandle } from './wallet-handle';

// Importing wallet-handle installs the sha512 hasher side-effect, so ed.sign
// works even before any WalletHandle is instantiated. Tests also awaiting
// `ready()` indirectly via Vault tests keep the ordering consistent.

async function makeKeyPair(): Promise<{ seed: Uint8Array; pubkey: Uint8Array }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pubkey = await ed.getPublicKeyAsync(seed);
  return { seed, pubkey };
}

describe('WalletHandle', () => {
  let seed: Uint8Array;
  let pubkey: Uint8Array;
  let address: PublicKey;

  beforeAll(async () => {
    ({ seed, pubkey } = await makeKeyPair());
    address = PublicKey.fromBytes(pubkey);
  });

  it('exposes only address, role, and sign methods — no raw secret getter', () => {
    const h = new WalletHandle('trader', address, seed);
    const enumerable = Object.keys(h);
    // The `#secretKey` private field must be invisible to reflection from
    // outside the class.
    expect(enumerable).not.toContain('#secretKey');
    expect(enumerable).not.toContain('secretKey');
    expect(enumerable).not.toContain('_secretKey');
    // Own-property keys including non-enumerable ones — still must not expose
    // the secret.
    const own = Reflect.ownKeys(h).map(String);
    expect(own.some((k) => k.toLowerCase().includes('secret'))).toBe(false);
  });

  it('JSON.stringify never contains the raw secret bytes', () => {
    const h = new WalletHandle('trader', address, seed);
    const json = JSON.stringify(h);
    // Secret bytes as hex — must not appear in any form we care about.
    const hex = Buffer.from(seed).toString('hex');
    expect(json).not.toContain(hex);
    // Also check base64, just in case a future refactor serializes that way.
    const b64 = Buffer.from(seed).toString('base64');
    expect(json).not.toContain(b64);
    // Still exposes the safe metadata fields.
    const parsed = JSON.parse(json);
    expect(parsed.address).toBe(address.toBase58());
    expect(parsed.role).toBe('trader');
    expect(parsed.locked).toBe(false);
  });

  it('sign produces a signature verifiable against the public key', async () => {
    const h = new WalletHandle('trader', address, seed);
    const msg = new TextEncoder().encode('hello solana');
    const sig = await h.sign(msg);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(await ed.verifyAsync(sig, msg, pubkey)).toBe(true);
  });

  it('signTransaction emits [1 || sig(64) || message] with a verifiable signature', async () => {
    const h = new WalletHandle('trader', address, seed);
    // Synthetic v0 tx wire: [count=1 || zero-filled sig || message payload]
    const message = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const tx = new Uint8Array(1 + 64 + message.length);
    tx[0] = 1;
    tx.set(message, 1 + 64);

    const signed = await h.signTransaction(tx);
    expect(signed[0]).toBe(1);
    // Output is [count(1) || new_sig(64) || tx.slice(1)]. Per the T11 spec
    // the input's own 64-byte placeholder sig stays inside the signed region.
    const expectedSignable = tx.slice(1);
    expect(signed.length).toBe(1 + 64 + expectedSignable.length);
    const sig = signed.slice(1, 1 + 64);
    const signedMessage = signed.slice(1 + 64);
    expect(Buffer.from(signedMessage).equals(Buffer.from(expectedSignable))).toBe(true);
    expect(await ed.verifyAsync(sig, expectedSignable, pubkey)).toBe(true);
  });

  it('throws on signTransaction when given a zero-byte buffer', async () => {
    const h = new WalletHandle('trader', address, seed);
    await expect(h.signTransaction(new Uint8Array(0))).rejects.toThrow(/too short/);
  });

  it('rejects signTransaction inputs shorter than the 65-byte prefix+slot', async () => {
    const h = new WalletHandle('trader', address, seed);
    // 63 bytes is just shy of the 1 + 64 = 65-byte minimum. Must throw the
    // length guard error before touching the key, so we catch malformed input
    // rather than producing a silently wrong signature.
    const short = new Uint8Array(63);
    short[0] = 1;
    await expect(h.signTransaction(short)).rejects.toThrow(/too short/);
  });

  it('rejects signTransaction inputs whose tx[0] !== 1 (not single-signer)', async () => {
    const h = new WalletHandle('trader', address, seed);
    // Layout size is fine, but the signature count prefix is wrong — this is
    // the exact shape a multi-signer v0 tx would have and we refuse to sign it.
    const twoSigner = new Uint8Array(1 + 64 + 4);
    twoSigner[0] = 2;
    await expect(h.signTransaction(twoSigner)).rejects.toThrow(
      /only single-signer/,
    );
    const zeroSigner = new Uint8Array(1 + 64 + 4);
    zeroSigner[0] = 0;
    await expect(h.signTransaction(zeroSigner)).rejects.toThrow(
      /only single-signer/,
    );
  });

  it('accepts signTransaction at exactly V0_TX_MIN_LENGTH (65 bytes)', async () => {
    const h = new WalletHandle('trader', address, seed);
    // [1 || zero(64)] — the minimum valid shape. The output re-includes the
    // 64-byte placeholder region as part of the signed message (tx.slice(1)),
    // so the output length is 1 + 64 + 64 = 129 bytes. This is the documented
    // T11 behaviour, kept intact by the new guards.
    const tx = new Uint8Array(1 + 64);
    tx[0] = 1;
    const signed = await h.signTransaction(tx);
    expect(signed.length).toBe(1 + 64 + 64);
    expect(signed[0]).toBe(1);
    // Signature must verify against the signed portion (tx.slice(1)).
    const sig = signed.slice(1, 1 + 64);
    expect(await ed.verifyAsync(sig, tx.slice(1), pubkey)).toBe(true);
  });

  it('rejects construction with a non-32-byte seed', () => {
    expect(() => new WalletHandle('x', address, new Uint8Array(16))).toThrow(/32-byte/);
    expect(() => new WalletHandle('x', address, new Uint8Array(64))).toThrow(/32-byte/);
  });

  it('isLocked flips after _lock() and signing afterwards throws', async () => {
    const h = new WalletHandle('trader', address, seed);
    expect(h.isLocked).toBe(false);
    h._lock();
    expect(h.isLocked).toBe(true);
    await expect(h.sign(new Uint8Array([1]))).rejects.toThrow(/locked/);
    const tx = new Uint8Array(1 + 64 + 4);
    await expect(h.signTransaction(tx)).rejects.toThrow(/locked/);
  });

  it('_lock is idempotent', () => {
    const h = new WalletHandle('trader', address, seed);
    h._lock();
    h._lock(); // must not throw
    expect(h.isLocked).toBe(true);
  });

  it('defensive copy: mutating caller seed does not invalidate handle', async () => {
    const mutableSeed = new Uint8Array(seed);
    const h = new WalletHandle('trader', address, mutableSeed);
    mutableSeed.fill(0xff);
    const msg = new TextEncoder().encode('after mutation');
    const sig = await h.sign(msg);
    expect(await ed.verifyAsync(sig, msg, pubkey)).toBe(true);
  });

  it('invokes the onSign hook on both sign and signTransaction', async () => {
    const hook = vi.fn();
    const h = new WalletHandle('trader', address, seed, hook);
    await h.sign(new Uint8Array([1, 2, 3]));
    expect(hook).toHaveBeenCalledWith('sign', { kind: 'message', byteLength: 3 });

    const tx = new Uint8Array(1 + 64 + 8);
    tx[0] = 1;
    await h.signTransaction(tx);
    expect(hook).toHaveBeenCalledWith('sign', { kind: 'transaction', byteLength: 73 });
  });
});
