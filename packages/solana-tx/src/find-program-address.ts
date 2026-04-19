/**
 * `findProgramAddress` — derive a Program Derived Address (PDA).
 *
 * A PDA is an off-curve 32-byte value produced by iteratively hashing the
 * caller-supplied seeds together with a "bump" byte, a program ID, and the
 * constant marker string `"ProgramDerivedAddress"`, then checking that the
 * resulting 32 bytes do NOT decode to a valid ed25519 curve point. The first
 * bump (counting down from 255) that produces an off-curve hash is the
 * canonical PDA for that seed set.
 *
 * Why off-curve matters: Solana will never hold a PDA's private key — there
 * simply is no ed25519 keypair for an off-curve 32-byte string. Programs
 * "sign" on behalf of PDAs by providing the matching seeds + bump via the
 * runtime's `invoke_signed` mechanism, and the runtime verifies the
 * derivation instead of a signature. Requiring off-curve output is what
 * guarantees PDAs and user-signable addresses live in disjoint spaces.
 *
 * Algorithm (Solana SDK parity):
 *
 *   for bump in 255..=0:
 *     hash = sha256(seed_0 || seed_1 || ... || [bump] || programId || "ProgramDerivedAddress")
 *     if hash is off-curve (not a valid ed25519 point):
 *       return { address: hash, bump }
 *   error: no off-curve PDA found
 *
 * The off-curve check uses `@noble/ed25519`'s `Point.fromHex` / `Point.fromBytes`,
 * which throws on invalid encodings. A throw means "not a valid curve point" —
 * exactly what we want. A successful decode means "on-curve", so we continue
 * to the next bump.
 *
 * Constraints enforced here match the Solana runtime:
 *
 *   - Seeds: up to 16, each at most 32 bytes.
 *   - Bumps: u8, iterated from 255 down to 0.
 *   - Marker: the literal ASCII `"ProgramDerivedAddress"` (no null terminator).
 *
 * Determinism: same inputs ALWAYS produce the same `{ address, bump }`. The
 * algorithm has no randomness and no dependence on wall-clock time.
 *
 * Zero ecosystem-SDK deps: only `@noble/ed25519` (permitted for PDA
 * derivation) and `@noble/hashes/sha2` for sha256. Pubkeys flow through the
 * substrate's own `PublicKey` type.
 */

import { PublicKey } from '@ap3x/solana-core';
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

/**
 * @noble/ed25519 v2.x defers SHA-512 to the host for its scalar-hashing and
 * point-decompression math. `Point.fromHex` / `Point.fromBytes` can call the
 * sync path; we install both sync + async hashers here so the off-curve
 * check works in every runtime without relying on WebCrypto availability.
 *
 * This mirrors the exact wiring used in `@ap3x/solana-vault`'s wallet-handle,
 * so behaviour across the substrate is uniform. Multiple installs are
 * idempotent — the last write wins and all point to the same hash function.
 */
ed.etc.sha512Async = (...msgs: Uint8Array[]) =>
  Promise.resolve(sha512(ed.etc.concatBytes(...msgs)));
ed.etc.sha512Sync = (...msgs: Uint8Array[]) =>
  sha512(ed.etc.concatBytes(...msgs));

/** Max seed byte length the Solana runtime accepts (`MAX_SEED_LEN`). */
const MAX_SEED_LENGTH = 32;

/** Max number of seeds the Solana runtime accepts (`MAX_SEEDS`). */
const MAX_SEEDS = 16;

/**
 * The literal marker string appended to the hash preimage to namespace PDAs
 * away from any other sha256 use. Exact match with the Solana SDK.
 */
const PDA_MARKER = /* @__PURE__ */ new TextEncoder().encode('ProgramDerivedAddress');

/**
 * Result of a successful PDA derivation.
 *
 *   - `address` — the derived 32-byte off-curve address as a {@link PublicKey}.
 *   - `bump` — the u8 nonce that produced it, in `[0, 255]`. Callers usually
 *     stash this to reproduce the derivation cheaply on later calls.
 */
export interface FindProgramAddressResult {
  address: PublicKey;
  bump: number;
}

/**
 * Check whether a 32-byte hash decodes to a valid ed25519 point.
 *
 * Returns `true` iff `Point.fromHex(hash)` succeeds. The noble library
 * throws for any invalid encoding (non-curve, bad sign bit, malformed, etc.),
 * which covers exactly the cases we want to treat as "off-curve".
 *
 * Clone-safe: we pass the hash directly to noble without retaining a
 * reference.
 */
function isOnCurve(hash: Uint8Array): boolean {
  try {
    ed.Point.fromHex(hash);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive a Program Derived Address.
 *
 * @param seeds     Up to 16 seed byte arrays, each at most 32 bytes.
 * @param programId The program ID the PDA belongs to.
 * @throws RangeError if `seeds.length > 16` or any seed exceeds 32 bytes.
 * @throws Error     if no off-curve PDA is found (pathologically rare —
 *                   the search space is 256 bumps and each independently has
 *                   ≈ 50% chance of being off-curve).
 */
export function findProgramAddress(
  seeds: Uint8Array[],
  programId: PublicKey,
): FindProgramAddressResult {
  if (seeds.length > MAX_SEEDS) {
    throw new RangeError(
      `findProgramAddress: too many seeds — got ${seeds.length}, max ${MAX_SEEDS}`,
    );
  }
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!;
    if (s.length > MAX_SEED_LENGTH) {
      throw new RangeError(
        `findProgramAddress: seed[${i}] length ${s.length} exceeds max ${MAX_SEED_LENGTH}`,
      );
    }
  }

  const programBytes = programId.toBuffer();

  // Pre-compute the fixed portion of the preimage length so the per-bump
  // allocation loop doesn't repeat work.
  let seedsLen = 0;
  for (const s of seeds) seedsLen += s.length;
  const preimageLen = seedsLen + 1 /* bump */ + programBytes.length + PDA_MARKER.length;

  // Iterate bumps high → low so the canonical PDA (highest off-curve bump)
  // is discovered first. Matches Solana's `Pubkey::find_program_address`.
  for (let bump = 255; bump >= 0; bump--) {
    const preimage = new Uint8Array(preimageLen);
    let off = 0;
    for (const s of seeds) {
      preimage.set(s, off);
      off += s.length;
    }
    preimage[off] = bump;
    off += 1;
    preimage.set(programBytes, off);
    off += programBytes.length;
    preimage.set(PDA_MARKER, off);
    // off += PDA_MARKER.length; — final, no further writes.

    const hash = sha256(preimage);
    if (!isOnCurve(hash)) {
      return { address: PublicKey.fromBytes(hash), bump };
    }
  }

  // In theory unreachable: for a random seed set the probability that ALL
  // 256 bumps produce on-curve hashes is ≈ 2^-256. We still surface a
  // descriptive error rather than returning `undefined`, so a caller that
  // somehow hits this case fails loudly.
  throw new Error(
    'findProgramAddress: exhausted all 256 bumps without finding an off-curve PDA',
  );
}
