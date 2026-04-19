import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import sodium from 'libsodium-wrappers-sumo';
import * as ed from '@noble/ed25519';

import { FileVaultStorage } from './storage-file';
import { ready } from './crypto';
import { Vault, validatePassphrase } from './vault';
import { WalletHandle, WalletReserveBreach } from './wallet-handle';

const STRONG_PASSPHRASE = 'Horse-Battery-Staple-42!';

let KDF_MIN: { opslimit: number; memlimit: number };

beforeAll(async () => {
  await ready();
  // Use the fastest valid Argon2id parameters so the full vault test suite
  // (including the fast-check 100-case property test) runs in well under a
  // minute. Real vaults default to MODERATE.
  KDF_MIN = {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_MIN,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_MIN,
  };
});

async function freshVault(): Promise<{ vault: Vault; baseDir: string; storage: FileVaultStorage }> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
  const storage = new FileVaultStorage({ baseDir });
  const vault = new Vault({ storage, kdf: KDF_MIN });
  return { vault, baseDir, storage };
}

function randomSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe('validatePassphrase', () => {
  it('accepts a passphrase that meets defaults', () => {
    expect(() => validatePassphrase(STRONG_PASSPHRASE)).not.toThrow();
  });

  it('rejects passphrases shorter than 12 chars', () => {
    expect(() => validatePassphrase('Short1!')).toThrow(/at least 12/);
  });

  it('rejects passphrases with <3 character categories', () => {
    expect(() => validatePassphrase('alllowercasenocat')).toThrow(/at least 3/);
    expect(() => validatePassphrase('ALLUPPERCASENOTHING')).toThrow(/at least 3/);
    expect(() => validatePassphrase('lowercaseUPPERCASE')).toThrow(/at least 3/);
  });

  it('accepts passphrases exactly meeting the minimums', () => {
    // 12 chars, 3 categories: lower + upper + digit
    expect(() => validatePassphrase('Abcdefghij12')).not.toThrow();
  });

  it('honours policy overrides', () => {
    expect(() => validatePassphrase('short', { minLength: 4, minCategories: 1 })).not.toThrow();
    expect(() =>
      validatePassphrase('AllFourCategories123!', { minCategories: 4 }),
    ).not.toThrow();
  });
});

describe('Vault — addWallet / unlock / lock', () => {
  let vault: Vault;
  let baseDir: string;

  beforeEach(async () => {
    ({ vault, baseDir } = await freshVault());
  });

  afterEach(async () => {
    vault.lockAll();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('addWallet writes an encrypted record readable via list()', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const entries = await vault.list();
    expect(entries.length).toBe(1);
    expect(entries[0]?.name).toBe('main');
    expect(entries[0]?.role).toBe('trader');
    expect(entries[0]?.address.length).toBeGreaterThan(32);
  });

  it('unlock returns a WalletHandle whose sign verifies against the stored address', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const handle = await vault.unlock('main', STRONG_PASSPHRASE);

    expect(handle).toBeInstanceOf(WalletHandle);
    expect(handle.role).toBe('trader');

    const msg = new TextEncoder().encode('auth proof');
    const sig = await handle.sign(msg);
    const pubkey = handle.address.toBuffer();
    expect(await ed.verifyAsync(sig, msg, pubkey)).toBe(true);
  });

  it('lock zeroes the handle so subsequent sign calls throw', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const handle = await vault.unlock('main', STRONG_PASSPHRASE);
    vault.lock('main');
    expect(handle.isLocked).toBe(true);
    await expect(handle.sign(new Uint8Array([1]))).rejects.toThrow(/locked/);
  });

  it('lock is idempotent and safe on never-unlocked wallets', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    expect(() => vault.lock('main')).not.toThrow(); // never unlocked
    expect(() => vault.lock('nonexistent')).not.toThrow();
  });

  it('double unlock locks the previous handle before issuing a new one', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const first = await vault.unlock('main', STRONG_PASSPHRASE);
    const second = await vault.unlock('main', STRONG_PASSPHRASE);
    expect(first.isLocked).toBe(true);
    expect(second.isLocked).toBe(false);
  });

  it('rejects the wrong passphrase with a generic error (no oracle)', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    await expect(vault.unlock('main', 'Wrong-Passphrase-42!')).rejects.toThrow(/invalid passphrase/);
  });

  it('throws a findable "not found" error for missing wallets', async () => {
    await expect(vault.unlock('ghost', STRONG_PASSPHRASE)).rejects.toThrow(/not found/);
  });

  it('addWallet enforces the passphrase policy', async () => {
    const seed = randomSeed();
    await expect(vault.addWallet('x', 'trader', seed, 'short')).rejects.toThrow(/at least 12/);
    await expect(vault.addWallet('x', 'trader', seed, 'onlylowercase12345')).rejects.toThrow(
      /at least 3/,
    );
  });

  it('addWallet rejects non-32-byte secret keys', async () => {
    await expect(
      vault.addWallet('x', 'trader', new Uint8Array(64), STRONG_PASSPHRASE),
    ).rejects.toThrow(/32-byte/);
  });

  it('persisted record never contains the plaintext secret', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const raw = await fs.readFile(path.join(baseDir, 'main.json'), 'utf-8');
    // The 32 seed bytes must not appear in the on-disk record in hex or base64.
    const hex = Buffer.from(seed).toString('hex');
    const b64 = Buffer.from(seed).toString('base64');
    expect(raw).not.toContain(hex);
    expect(raw).not.toContain(b64);
    // And the record's ciphertext field should NOT equal the plaintext.
    const parsed = JSON.parse(raw);
    expect(parsed.encryption.ciphertext).not.toBe(b64);
  });

  it('signTransaction produces a v0-structured output verifiable against address', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const handle = await vault.unlock('main', STRONG_PASSPHRASE);

    const payload = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
    const tx = new Uint8Array(1 + 64 + payload.length);
    tx[0] = 1;
    tx.set(payload, 1 + 64);

    const signed = await handle.signTransaction(tx);
    expect(signed[0]).toBe(1);
    const sig = signed.slice(1, 1 + 64);
    const signedMessage = signed.slice(1 + 64);
    expect(
      await ed.verifyAsync(sig, tx.slice(1), handle.address.toBuffer()),
    ).toBe(true);
    // The trailing message bytes must match the original payload we embedded.
    expect(Buffer.from(signedMessage).equals(Buffer.from(tx.slice(1)))).toBe(true);
  });

  it('writes a create audit entry on addWallet and unlock entry on unlock', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    let audit = await vault.audit('main');
    expect(audit.length).toBe(1);
    expect(audit[0]?.event).toBe('create');

    await vault.unlock('main', STRONG_PASSPHRASE);
    audit = await vault.audit('main');
    expect(audit.length).toBe(2);
    expect(audit[1]?.event).toBe('unlock');
  });

  it('writes a sign audit entry after successful sign / signTransaction', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const handle = await vault.unlock('main', STRONG_PASSPHRASE);
    await handle.sign(new Uint8Array([1, 2, 3]));
    const tx = new Uint8Array(1 + 64 + 4);
    tx[0] = 1;
    await handle.signTransaction(tx);
    const audit = await vault.audit('main');
    const signEvents = audit.filter((e) => e.event === 'sign');
    expect(signEvents.length).toBe(2);
    expect(signEvents[0]?.metadata?.kind).toBe('message');
    expect(signEvents[1]?.metadata?.kind).toBe('transaction');
  });

  it('audit on an unknown wallet returns empty array', async () => {
    expect(await vault.audit('never-existed')).toEqual([]);
  });

  it('list returns empty when no wallets exist yet', async () => {
    expect(await vault.list()).toEqual([]);
  });

  it('addWallet refuses to silently overwrite an existing wallet', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    // Second call without overwrite must throw — a security primitive should
    // never discard keys without explicit opt-in.
    await expect(
      vault.addWallet('main', 'trader', randomSeed(), STRONG_PASSPHRASE),
    ).rejects.toThrow(/already exists/);
  });

  it('addWallet with { overwrite: true } replaces the existing record', async () => {
    const firstSeed = randomSeed();
    const firstPassphrase = STRONG_PASSPHRASE;
    await vault.addWallet('main', 'trader', firstSeed, firstPassphrase);

    const secondSeed = randomSeed();
    const secondPassphrase = 'Brand-New-Passphrase-99!';
    await vault.addWallet(
      'main',
      'trader',
      secondSeed,
      secondPassphrase,
      { overwrite: true },
    );

    // New passphrase + new seed work: unlocked handle's pubkey matches the
    // new seed's derived pubkey.
    const handle = await vault.unlock('main', secondPassphrase);
    const expectedPubkey = await ed.getPublicKeyAsync(secondSeed);
    expect(Buffer.from(handle.address.toBuffer()).equals(Buffer.from(expectedPubkey))).toBe(true);
    vault.lock('main');

    // Old passphrase fails — we really did replace, not append.
    await expect(vault.unlock('main', firstPassphrase)).rejects.toThrow(
      /invalid passphrase/,
    );
  });
});

describe('Vault — rotateKey', () => {
  let vault: Vault;
  let baseDir: string;

  beforeEach(async () => {
    ({ vault, baseDir } = await freshVault());
  });

  afterEach(async () => {
    vault.lockAll();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('rotates a wallet so the new passphrase unlocks and derives the same address', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const firstHandle = await vault.unlock('main', STRONG_PASSPHRASE);
    const addressBefore = firstHandle.address.toBase58();
    vault.lock('main');

    const newPassphrase = 'Fresh-New-Passphrase-99!';
    await vault.rotateKey('main', STRONG_PASSPHRASE, newPassphrase);

    // New passphrase works, and derives the SAME address — rotation changes
    // the encryption key, not the underlying ed25519 seed.
    const rotated = await vault.unlock('main', newPassphrase);
    expect(rotated.address.toBase58()).toBe(addressBefore);

    // And the signing key is functionally identical: the same message under
    // the same seed produces a signature that verifies against the same pubkey.
    const msg = new TextEncoder().encode('post-rotate');
    const sig = await rotated.sign(msg);
    expect(await ed.verifyAsync(sig, msg, rotated.address.toBuffer())).toBe(true);
  });

  it('invalidates the old passphrase after rotation (one-way)', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const newPassphrase = 'Another-Strong-One-77!';
    await vault.rotateKey('main', STRONG_PASSPHRASE, newPassphrase);

    await expect(vault.unlock('main', STRONG_PASSPHRASE)).rejects.toThrow(
      /invalid passphrase/,
    );
  });

  it('rejects rotateKey when the old passphrase is wrong', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    await expect(
      vault.rotateKey('main', 'Wrong-Old-Passphrase-99!', 'Brand-New-Pp-42!'),
    ).rejects.toThrow(/invalid passphrase/);
  });

  it('rejects rotateKey when the new passphrase fails the policy', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    await expect(
      vault.rotateKey('main', STRONG_PASSPHRASE, 'short'),
    ).rejects.toThrow(/at least 12/);
    await expect(
      vault.rotateKey('main', STRONG_PASSPHRASE, 'alllowercasenothingelse'),
    ).rejects.toThrow(/at least 3/);
  });

  it('rejects rotateKey on an unknown wallet', async () => {
    await expect(
      vault.rotateKey('ghost', STRONG_PASSPHRASE, 'Brand-New-Pp-42!'),
    ).rejects.toThrow(/not found/);
  });

  it('writes a rotate audit entry after successful rotation', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    await vault.rotateKey('main', STRONG_PASSPHRASE, 'Brand-New-Pp-42!');
    const audit = await vault.audit('main');
    const rotateEvents = audit.filter((e) => e.event === 'rotate');
    expect(rotateEvents.length).toBe(1);
    expect(rotateEvents[0]?.metadata?.role).toBe('trader');
  });

  it('rotation changes the on-disk salt + ciphertext (so re-encryption really happened)', async () => {
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const before = JSON.parse(
      await fs.readFile(path.join(baseDir, 'main.json'), 'utf-8'),
    );
    await vault.rotateKey('main', STRONG_PASSPHRASE, 'Another-Fresh-Pp-42!');
    const after = JSON.parse(
      await fs.readFile(path.join(baseDir, 'main.json'), 'utf-8'),
    );
    // Salt must change so an old key never matches the new record.
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    // Ciphertext must change (fresh nonce + fresh key = different output).
    expect(after.encryption.ciphertext).not.toBe(before.encryption.ciphertext);
    // Address / name / role are preserved — same underlying seed.
    expect(after.address).toBe(before.address);
    expect(after.name).toBe(before.name);
    expect(after.role).toBe(before.role);
  });
});

describe('Vault — SOL reserve guard integration', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-reserve-'));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('unlock applies solReserveByRole to the wallet handle', async () => {
    const storage = new FileVaultStorage({ baseDir });
    const vault = new Vault({
      storage,
      kdf: KDF_MIN,
      solReserveByRole: { trader: 1_000_000n },
    });
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    const handle = await vault.unlock('main', STRONG_PASSPHRASE, {
      getBalance: async () => 2_000_000n,
      estimateDelta: () => -1_500_000n,
    });
    const tx = new Uint8Array(1 + 64 + 4);
    tx[0] = 1;
    // Projected 500k < reserve 1M → breach.
    await expect(handle.signTransaction(tx)).rejects.toBeInstanceOf(
      WalletReserveBreach,
    );
    vault.lockAll();
  });

  it('wallets whose role has no reserve policy configured sign normally', async () => {
    const storage = new FileVaultStorage({ baseDir });
    const vault = new Vault({
      storage,
      kdf: KDF_MIN,
      solReserveByRole: { trader: 10_000_000n }, // no policy for 'warm-wallet'
    });
    const seed = randomSeed();
    await vault.addWallet('warm', 'warm-wallet', seed, STRONG_PASSPHRASE);
    const handle = await vault.unlock('warm', STRONG_PASSPHRASE, {
      getBalance: async () => 0n,
      estimateDelta: () => -999_999n,
    });
    const tx = new Uint8Array(1 + 64 + 4);
    tx[0] = 1;
    // No reserve policy for this role → guard never trips even though balance
    // would obviously drop below zero. This is the documented graceful default.
    await expect(handle.signTransaction(tx)).resolves.toBeDefined();
    vault.lockAll();
  });

  it('unlock without getBalance/estimateDelta disables the guard even if reserve is set', async () => {
    const storage = new FileVaultStorage({ baseDir });
    const vault = new Vault({
      storage,
      kdf: KDF_MIN,
      solReserveByRole: { trader: 10_000_000n },
    });
    const seed = randomSeed();
    await vault.addWallet('main', 'trader', seed, STRONG_PASSPHRASE);
    // No reserve hooks passed — guard silently no-ops because we cannot check.
    const handle = await vault.unlock('main', STRONG_PASSPHRASE);
    const tx = new Uint8Array(1 + 64 + 4);
    tx[0] = 1;
    await expect(handle.signTransaction(tx)).resolves.toBeDefined();
    vault.lockAll();
  });
});

describe('Vault — property: encrypt → decrypt → sign → verify over random keypairs', () => {
  it('holds for 100 random 32-byte seeds', async () => {
    const { vault, baseDir } = await freshVault();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          fc.uint8Array({ minLength: 1, maxLength: 128 }),
          fc.integer({ min: 0, max: 1_000_000 }),
          async (seedBytes, message, counter) => {
            const name = `w${counter}`;
            // fast-check may shrink `counter` to the same value across runs,
            // which would now collide with the duplicate-wallet guard. Opt
            // into overwrite for the property test — this is the one place
            // where "replace this slot repeatedly" is the intended behaviour.
            await vault.addWallet(name, 'trader', seedBytes, STRONG_PASSPHRASE, {
              overwrite: true,
            });
            const handle = await vault.unlock(name, STRONG_PASSPHRASE);
            const sig = await handle.sign(message);
            const ok = await ed.verifyAsync(sig, message, handle.address.toBuffer());
            vault.lock(name);
            return ok;
          },
        ),
        // 100 runs; fast-check default is 100 which matches the task spec.
        { numRuns: 100 },
      );
    } finally {
      vault.lockAll();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  }, 120_000);
});
