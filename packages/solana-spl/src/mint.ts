/**
 * SPL Token Mint account decoder.
 *
 * A mint describes a token's supply, decimals, and authorities. The v1 layout
 * is fixed at **82 bytes**:
 *
 *     offset  size  field
 *     ------  ----  -----
 *     0       36    mintAuthority     (COption<Pubkey>: 4-byte tag + 32-byte key)
 *     36      8     supply            (u64, little-endian)
 *     44      1     decimals          (u8)
 *     45      1     isInitialized     (u8, 0|1)
 *     46      36    freezeAuthority   (COption<Pubkey>)
 *     ------  ----
 *     total   82
 *
 * Note: SPL's `COption<T>` differs subtly from Borsh's `Option<T>`. Borsh uses
 * a single-byte discriminant (0|1); SPL uses a FOUR-byte little-endian
 * discriminant — only the low byte matters, the tag stores the full word
 * value `0` (None) or `1` (Some). We always consume all 36 bytes regardless of
 * tag value, because SPL pre-allocates the pubkey slot and zeroes it when
 * None. That's why a "None" authority on-chain still occupies 36 bytes, not 4.
 *
 * Token-2022 mints follow the same 82-byte base layout but are typically
 * padded out to >= 165 bytes so the TLV-extension region aligns with the
 * TokenAccount layout. The {@link ./token-2022-extensions} module handles
 * that region; this file only populates the fixed base fields plus
 * {@link TokenMint.tokenProgram}.
 *
 * Zero ecosystem-SDK deps: only `@ap3x/solana-core`.
 */

import { borsh, PublicKey } from '@ap3x/solana-core';
import type { Reader } from '@ap3x/solana-core';

import {
  detectTokenProgram,
  type AccountInfo,
  type TokenProgramKind,
} from './program-ids';

/** Minimum valid SPL mint data length, in bytes. */
export const MINT_ACCOUNT_SIZE = 82;

/**
 * Known Token-2022 mint-side extension values. Populated by
 * {@link ./token-2022-extensions} — the interface lives in that file; we
 * re-export a stub here so T24 doesn't take a hard dependency on the
 * extensions module. In T24, {@link decodeMint} never populates this field.
 */
export type TokenMintExtensionsLike = Record<string, unknown>;

/** A TLV entry we couldn't decode into a known extension shape. */
export interface UnknownMintExtension {
  /** Extension type ID (u16). */
  type: number;
  /** Raw extension payload bytes. */
  data: Uint8Array;
}

/**
 * Decoded SPL Token Mint. Authority fields are `null` when the SPL
 * `COption<Pubkey>` tag is zero (revoked or never set).
 */
export interface TokenMint {
  /**
   * Authority allowed to mint new tokens. `null` after the mint authority
   * has been revoked (SPL `COption<Pubkey>` tag = 0).
   */
  mintAuthority: PublicKey | null;
  /** Total circulating supply, as a raw u64 (no decimal scaling applied). */
  supply: bigint;
  /** Number of decimal places the UI should use when rendering supply. */
  decimals: number;
  /**
   * `true` once the mint has been initialized. Uninitialized mints serialized
   * on-chain generally aren't observable — but the flag is in the layout, so
   * we surface it verbatim rather than lying.
   */
  isInitialized: boolean;
  /**
   * Authority allowed to freeze token accounts of this mint. `null` when
   * the freeze authority has been revoked or never set.
   */
  freezeAuthority: PublicKey | null;
  /** Which SPL Token flavour owns the account (`detectTokenProgram`). */
  tokenProgram: TokenProgramKind;
  /**
   * Known Token-2022 extension values. Only populated by the extensions
   * module ({@link ./token-2022-extensions}); absent when the caller uses
   * only the base decoder or when the account is `spl-v1`.
   */
  extensions?: TokenMintExtensionsLike;
  /**
   * TLV entries we couldn't decode into {@link extensions}. Same population
   * rules as {@link extensions}.
   */
  unknownExtensions?: UnknownMintExtension[];
}

/**
 * Read an SPL `COption<Pubkey>` — a 4-byte little-endian tag followed by a
 * 32-byte pubkey slot. Tag = 0 → `null` (and we still consume the 32 bytes
 * because SPL pre-allocates them as zero); tag = 1 → wrap the bytes in a
 * {@link PublicKey}. Any other tag value throws — that's an on-chain
 * anomaly we should not paper over.
 */
export function readCOptionPubkey(
  r: Reader,
  field: string,
): PublicKey | null {
  const tag = r.readU32();
  const pkBytes = r.readBytes(32);
  if (tag === 0) return null;
  if (tag === 1) return PublicKey.fromBytes(pkBytes);
  throw new Error(
    `spl: invalid COption<Pubkey> tag ${tag} for ${field} — expected 0 or 1`,
  );
}

/**
 * Decode an SPL Token Mint account.
 *
 * @throws Error if `account.data.length < 82`
 * @throws Error if a COption<Pubkey> tag is neither 0 nor 1
 */
export function decodeMint(account: AccountInfo): TokenMint {
  if (account.data.length < MINT_ACCOUNT_SIZE) {
    throw new Error(
      `decodeMint: data too short — got ${account.data.length} bytes, need at least ${MINT_ACCOUNT_SIZE}`,
    );
  }

  // Parse the fixed 82-byte base layout first. Slicing guards the Reader
  // against accidentally consuming extension bytes as base fields.
  const base = account.data.subarray(0, MINT_ACCOUNT_SIZE);
  const r = new borsh.Reader(base);

  const mintAuthority = readCOptionPubkey(r, 'mintAuthority');
  const supply = r.readU64();
  const decimals = r.readU8();
  // `isInitialized` is a u8, but in practice always 0 or 1 on-chain. We use
  // readBool rather than readU8 so we catch any corrupted value.
  const isInitialized = r.readBool();
  const freezeAuthority = readCOptionPubkey(r, 'freezeAuthority');

  const tokenProgram = detectTokenProgram(account);

  return {
    mintAuthority,
    supply,
    decimals,
    isInitialized,
    freezeAuthority,
    tokenProgram,
  };
}
