import { describe, expect, it, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';

import { decrypt, deriveKey, encrypt, ready } from './crypto';

// Argon2id with production parameters is slow (hundreds of ms). Tests use the
// library's MIN ops/mem limits (~10 ms per derive). Do NOT use these defaults
// for the Vault itself (T11) — MODERATE or higher is required there.
let opslimit: number;
let memlimit: number;
let saltBytes: number;

beforeAll(async () => {
  await ready();
  opslimit = sodium.crypto_pwhash_OPSLIMIT_MIN;
  memlimit = sodium.crypto_pwhash_MEMLIMIT_MIN;
  saltBytes = sodium.crypto_pwhash_SALTBYTES;
});

function randomSalt(): Uint8Array {
  return sodium.randombytes_buf(saltBytes);
}

describe('deriveKey', () => {
  it('returns a 32-byte key', async () => {
    const salt = randomSalt();
    const key = await deriveKey('correct horse battery staple', salt, opslimit, memlimit);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('is deterministic for the same passphrase + salt + params', async () => {
    const salt = randomSalt();
    const a = await deriveKey('hunter2', salt, opslimit, memlimit);
    const b = await deriveKey('hunter2', salt, opslimit, memlimit);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('produces different keys for different salts', async () => {
    const saltA = randomSalt();
    const saltB = randomSalt();
    const a = await deriveKey('hunter2', saltA, opslimit, memlimit);
    const b = await deriveKey('hunter2', saltB, opslimit, memlimit);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('encrypt / decrypt', () => {
  async function randomKey(): Promise<Uint8Array> {
    await ready();
    return sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  }

  it('round-trips random plaintext', async () => {
    const key = await randomKey();
    const plaintext = sodium.randombytes_buf(128);
    const { nonce, ciphertext } = await encrypt(key, plaintext);
    const recovered = await decrypt(key, nonce, ciphertext);
    expect(Buffer.from(recovered).equals(Buffer.from(plaintext))).toBe(true);
  });

  it('round-trips empty plaintext', async () => {
    const key = await randomKey();
    const plaintext = new Uint8Array(0);
    const { nonce, ciphertext } = await encrypt(key, plaintext);
    const recovered = await decrypt(key, nonce, ciphertext);
    expect(recovered.length).toBe(0);
  });

  it('uses a fresh random nonce for each encrypt (same key + plaintext)', async () => {
    const key = await randomKey();
    const plaintext = new TextEncoder().encode('same plaintext, different nonce');
    const a = await encrypt(key, plaintext);
    const b = await encrypt(key, plaintext);
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it('throws when the ciphertext has been tampered with', async () => {
    const key = await randomKey();
    const plaintext = new TextEncoder().encode('sensitive secret');
    const { nonce, ciphertext } = await encrypt(key, plaintext);
    const tampered = new Uint8Array(ciphertext);
    // flip one bit somewhere in the middle
    const idx = Math.floor(tampered.length / 2);
    tampered.set([(tampered[idx] ?? 0) ^ 0x01], idx);
    await expect(decrypt(key, nonce, tampered)).rejects.toThrow();
  });

  it('throws when the nonce has been tampered with', async () => {
    const key = await randomKey();
    const plaintext = new TextEncoder().encode('sensitive secret');
    const { nonce, ciphertext } = await encrypt(key, plaintext);
    const tampered = new Uint8Array(nonce);
    tampered.set([(tampered[0] ?? 0) ^ 0x01], 0);
    await expect(decrypt(key, tampered, ciphertext)).rejects.toThrow();
  });

  it('throws when decrypting with the wrong key', async () => {
    const keyA = await randomKey();
    const keyB = await randomKey();
    const plaintext = new TextEncoder().encode('wrong-key test');
    const { nonce, ciphertext } = await encrypt(keyA, plaintext);
    await expect(decrypt(keyB, nonce, ciphertext)).rejects.toThrow();
  });
});

describe('end-to-end: Argon2id-derived key + secretbox round-trip', () => {
  it('derives a key from a passphrase and round-trips a payload', async () => {
    const salt = randomSalt();
    const key = await deriveKey('openSesame!', salt, opslimit, memlimit);
    const plaintext = new TextEncoder().encode('{"wallet":"something"}');
    const { nonce, ciphertext } = await encrypt(key, plaintext);
    const recovered = await decrypt(key, nonce, ciphertext);
    expect(new TextDecoder().decode(recovered)).toBe('{"wallet":"something"}');
  });
});
