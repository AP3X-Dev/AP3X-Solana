/**
 * Metaplex Token Metadata program PDA derivation.
 *
 * The Token Metadata program stores each NFT/token's off-chain metadata
 * pointer (name, symbol, URI, creators, etc.) at a deterministic PDA derived
 * from the mint. Convention (matching the canonical Metaplex SDK):
 *
 *     seeds     = ["metadata", METADATA_PROGRAM_ID, mint]
 *     programId = METADATA_PROGRAM_ID ("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
 *     address   = findProgramAddress(seeds, METADATA_PROGRAM_ID).address
 *
 * The seed literally is the ASCII string `"metadata"` (no null terminator),
 * so the `TextEncoder` output is the correct bytes without further massaging.
 *
 * Zero ecosystem-SDK deps: the PublicKey class comes from `@ap3x/solana-core`,
 * the PDA helper from `@ap3x/solana-tx`.
 */

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';

/**
 * Metaplex Token Metadata program ID
 * (`metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`). Used as both the owning
 * program for derived metadata PDAs and as a seed component in their
 * derivation.
 */
export const METADATA_PROGRAM_ID = /* @__PURE__ */ PublicKey.fromBase58(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

/**
 * Fixed first seed for metadata PDA derivation. Precomputed at module load
 * so every `getMetadataPda` call reuses the same bytes rather than
 * re-encoding the string on each invocation.
 */
const METADATA_SEED = /* @__PURE__ */ new TextEncoder().encode('metadata');

/** Result of {@link getMetadataPda}. */
export interface MetadataPda {
  /** Derived off-curve metadata account address. */
  address: PublicKey;
  /** Canonical bump used to produce the off-curve address. */
  bump: number;
}

/**
 * Derive the canonical metadata account PDA for a given mint.
 *
 * Deterministic: same mint always produces the same `{ address, bump }`.
 */
export function getMetadataPda(mint: PublicKey): MetadataPda {
  return findProgramAddress(
    [METADATA_SEED, METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  );
}
