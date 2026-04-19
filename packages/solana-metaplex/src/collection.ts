/**
 * Collection + creator helpers over decoded {@link MetadataAccount}
 * records. These exist because the raw decoder deliberately surfaces the
 * on-chain fields as-is — deciding whether a child NFT "belongs to" a
 * parent collection, or whether a creator has signed the metadata, is
 * semantic policy that callers should apply consistently.
 *
 * Both helpers are strict: they require the `verified` flag on the
 * relevant field. An unverified collection pointer or creator entry
 * counts as "not a member" — the Metaplex convention is that only the
 * program-signed update (or the creator's own `signMetadata` call) can
 * set that flag to `true`, so treating unverified entries as membership
 * is a spoofing vector we refuse to hand callers.
 *
 * Zero ecosystem-SDK deps: only `@ap3x/solana-core` for the PublicKey
 * type + the local {@link MetadataAccount} decoder.
 */

import type { PublicKey } from '@ap3x/solana-core';

import type { MetadataAccount } from './metadata-decoder';

/**
 * Is the given metadata a VERIFIED member of the parent collection mint?
 *
 * Semantics:
 *   - The metadata must carry a `collection` pointer (not `null`).
 *   - `collection.verified` must be `true` — unverified pointers are
 *     attacker-controlled and must not be trusted.
 *   - `collection.key` must byte-equal `parent`.
 *
 * Returns `false` if any of those checks fail.
 */
export function isCollectionMember(
  child: MetadataAccount,
  parent: PublicKey,
): boolean {
  const c = child.collection;
  if (c === null) return false;
  if (!c.verified) return false;
  return c.key.equals(parent);
}

/**
 * Is the given creator in the metadata's verified creator list?
 *
 * Returns `false` when:
 *   - The metadata has no creators array (`creators === null`).
 *   - No entry matches `creator` by byte-equal pubkey.
 *   - A matching entry exists but its `verified` flag is `false`.
 */
export function verifyCreator(
  metadata: MetadataAccount,
  creator: PublicKey,
): boolean {
  const cs = metadata.creators;
  if (cs === null) return false;
  for (const entry of cs) {
    if (entry.verified && entry.address.equals(creator)) return true;
  }
  return false;
}
