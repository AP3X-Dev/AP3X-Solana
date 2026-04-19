/**
 * Compressed-NFT (cNFT) reader — intentionally a stub in the substrate.
 *
 * Bubblegum-compressed NFTs store their metadata inside a merkle tree
 * rather than a per-asset on-chain account, so the resolution flow is
 * materially different: you need a DAS-compatible RPC endpoint
 * (`getAsset`) and a tree-proof fetcher. Both concerns are
 * venue-specific and belong in the Magic Eden / tensor / DAS verticals
 * — NOT in the vertical-agnostic metaplex package.
 *
 * We expose a {@link CompressedMetadataReader} interface so downstream
 * packages can plug in a real implementation without teaching the
 * substrate about cNFT internals, and a {@link defaultCompressedMetadataReader}
 * that throws a clear deferral error when invoked. That throw is
 * intentional: silent `null` returns would hide a real configuration
 * miss.
 *
 * Zero ecosystem-SDK deps: only `@ap3x/solana-core`.
 */

import type { PublicKey } from '@ap3x/solana-core';

import type { MetadataAccount } from './metadata-decoder';

/**
 * Pluggable reader for compressed-NFT metadata. Verticals that integrate
 * with a DAS endpoint (Helius, Triton, tensor) supply an implementation
 * that talks to their API and returns a {@link MetadataAccount} shaped
 * value, or `null` when the asset ID is unknown.
 */
export interface CompressedMetadataReader {
  /**
   * Look up metadata for a cNFT asset id (the leaf pubkey in the merkle
   * tree). Return `null` when the asset is unknown to the reader; throw
   * for transport errors.
   */
  read(asset: PublicKey): Promise<MetadataAccount | null>;
}

/**
 * Default stub — always throws. Exposed as a named export so callers can
 * reference it without guessing at the sentinel; the thrown message
 * explicitly points at the package that owns the real implementation.
 */
export const defaultCompressedMetadataReader: CompressedMetadataReader = {
  async read(_asset: PublicKey): Promise<MetadataAccount | null> {
    throw new Error('cNFT support deferred to magic-eden vertical');
  },
};
