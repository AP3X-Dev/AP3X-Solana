/**
 * AddressLookupTable (ALT) decoder.
 *
 * ALTs let a v0 transaction reference up to 256 extra accounts without
 * bloating the message bytes: the message carries only 1-byte indexes into
 * the table, and the on-chain ALT account stores the full 32-byte addresses.
 *
 * Account layout — fixed 56-byte metadata header followed by a packed
 * sequence of 32-byte pubkeys:
 *
 *   offset  size  field
 *   ------  ----  -----
 *     0       4   discriminator (u32 LE, = 1 for AddressLookupTable)
 *     4       8   deactivationSlot (u64 LE)
 *    12       8   lastExtendedSlot (u64 LE)
 *    20       1   lastExtendedSlotStartIndex (u8)
 *    21       1   authority Option tag (0 = None, 1 = Some; bincode default)
 *    22      32   authority pubkey (zeroed when tag = 0)
 *    54       2   _padding (u16, ignored)
 *    56     32*N  N addresses, each 32 bytes
 *
 * Total size = `LOOKUP_TABLE_META_SIZE + 32 * N` bytes.
 *
 * Only one ProgramState discriminator matters for decoding addresses: `1`
 * (`LookupTable`). Discriminator `0` is `Uninitialized` — the account exists
 * but holds no table; callers usually never see this once an ALT has been
 * created, but we still distinguish the case rather than silently returning
 * empty state.
 *
 * All integers are little-endian, matching the `Reader` from
 * `@ap3x/solana-core`'s borsh helpers. We're not decoding Borsh here — the
 * wire format is bincode's fixint layout — but the primitive reads (u32,
 * u64, u8, pubkey, raw bytes) are the same shape and we get all of them
 * for free from the substrate reader.
 */

import { PublicKey, Reader } from '@ap3x/solana-core';

/** Total size of the ALT metadata header in bytes. */
export const LOOKUP_TABLE_META_SIZE = 56;

/** ProgramState discriminator value that indicates a live LookupTable. */
export const ALT_DISCRIMINATOR_LOOKUP_TABLE = 1;

/**
 * Minimal account-info shape. We accept anything with a `data` payload —
 * the caller usually passes the `{ data, owner }` object they got back from
 * `getAccountInfo`. `owner` is optional: we don't enforce it here so
 * test fixtures stay simple, but callers in production should.
 */
export interface AccountInfo {
  data: Uint8Array;
  owner?: PublicKey;
}

/**
 * Decoded ALT state. Slots are `bigint` so callers using raw u64 values
 * don't silently lose precision when slot heights exceed 2^53.
 */
export interface AddressLookupTable {
  /**
   * Slot at which the table was (or will be) deactivated. The sentinel
   * `2^64 - 1` (`0xFFFFFFFFFFFFFFFF`) means "never deactivated"; callers
   * who care about activity state should compare against their current
   * clock rather than against this value directly.
   */
  deactivationSlot: bigint;
  /** Slot of the most recent extend instruction. */
  lastExtendedSlot: bigint;
  /** Index into `addresses` where the most recent extend began. */
  lastExtendedSlotStartIndex: number;
  /**
   * The table's authority, or `null` if the table has been frozen (authority
   * cleared by the owner). Note: the wire encoding always reserves 32 bytes
   * for the pubkey regardless of the Option tag — we only surface it when
   * the tag is `Some (1)`.
   */
  authority: PublicKey | null;
  /** Addresses packed after the header, in insertion order. */
  addresses: PublicKey[];
}

/**
 * Decode an ALT account into its structured form.
 *
 * @param account  Account-info-shaped object containing the raw `data` bytes.
 * @throws Error   If the data is shorter than the header, the discriminator
 *                 isn't `1` (LookupTable), or the trailing address region
 *                 is not a multiple of 32 bytes (malformed on-chain state).
 */
export function decodeAlt(account: AccountInfo): AddressLookupTable {
  const data = account.data;
  if (data.length < LOOKUP_TABLE_META_SIZE) {
    throw new Error(
      `decodeAlt: data too short — need at least ${LOOKUP_TABLE_META_SIZE} bytes for header, got ${data.length}`,
    );
  }

  const r = new Reader(data);
  const discriminator = r.readU32();
  if (discriminator !== ALT_DISCRIMINATOR_LOOKUP_TABLE) {
    throw new Error(
      `decodeAlt: unexpected discriminator ${discriminator} — expected ${ALT_DISCRIMINATOR_LOOKUP_TABLE} (LookupTable)`,
    );
  }
  const deactivationSlot = r.readU64();
  const lastExtendedSlot = r.readU64();
  const lastExtendedSlotStartIndex = r.readU8();

  // Option tag (bincode default: 1 byte). We use `readU8` rather than
  // `readBool` because bincode tolerates a broader tag range in theory,
  // but we still reject anything other than 0/1 — anything else means
  // the account is corrupted and we shouldn't hand back half-decoded data.
  const authorityTag = r.readU8();
  if (authorityTag !== 0 && authorityTag !== 1) {
    throw new Error(
      `decodeAlt: invalid authority option tag ${authorityTag} at offset ${r.offset - 1} — expected 0 or 1`,
    );
  }
  const authorityBytes = r.readBytes(32);
  const authority = authorityTag === 1 ? PublicKey.fromBytes(authorityBytes) : null;

  // Skip 2 bytes of reserved padding. We jump the cursor rather than
  // `readU16` so it's crystal-clear this region is discarded.
  r.offset = LOOKUP_TABLE_META_SIZE;

  // Addresses region: strict 32-byte alignment check. A partial pubkey at
  // the tail indicates on-chain corruption or a layout change we haven't
  // kept pace with; better to throw than silently drop bytes.
  const addressesLen = data.length - LOOKUP_TABLE_META_SIZE;
  if (addressesLen % 32 !== 0) {
    throw new Error(
      `decodeAlt: addresses region length ${addressesLen} is not a multiple of 32`,
    );
  }
  const addressCount = addressesLen / 32;
  const addresses: PublicKey[] = new Array<PublicKey>(addressCount);
  for (let i = 0; i < addressCount; i++) {
    addresses[i] = r.readPubkey();
  }

  return {
    deactivationSlot,
    lastExtendedSlot,
    lastExtendedSlotStartIndex,
    authority,
    addresses,
  };
}

/**
 * Result of a coverage query: the ALT plus the required keys it covers.
 */
export interface AltCoverage {
  alt: AddressLookupTable;
  covered: PublicKey[];
}

/**
 * Find ALTs that cover the largest share of `requiredKeys`, sorted by
 * descending coverage. Zero-coverage ALTs are omitted so callers can act
 * on the returned list directly without re-filtering.
 *
 * This is the first-order packer: a tx assembler that wants to compress
 * its account list picks the top-ranked ALT, records the indexes for the
 * covered keys, then repeats on the residual key set with the remaining
 * ALTs. The greedy top-coverage heuristic is optimal for the common
 * "small number of ALTs, mostly disjoint" case that real Solana wallets
 * maintain; for pathological overlap patterns a subset-cover algorithm
 * would be strictly better — we leave that to PRP-03 if it ever matters.
 *
 * Ties are broken by input order (stable sort), which keeps behaviour
 * deterministic for tests that feed ALTs in a fixed sequence.
 */
export function findInstructionsForKeys(
  alts: AddressLookupTable[],
  requiredKeys: PublicKey[],
): AltCoverage[] {
  const scored: AltCoverage[] = [];
  for (const alt of alts) {
    const covered: PublicKey[] = [];
    for (const key of requiredKeys) {
      if (alt.addresses.some((a) => a.equals(key))) {
        covered.push(key);
      }
    }
    if (covered.length > 0) scored.push({ alt, covered });
  }
  // Array.prototype.sort is stable in ES2019+, which we rely on for
  // deterministic tie-breaking.
  scored.sort((a, b) => b.covered.length - a.covered.length);
  return scored;
}
