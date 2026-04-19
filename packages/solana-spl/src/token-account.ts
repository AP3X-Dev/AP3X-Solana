/**
 * SPL Token Account decoder.
 *
 * A token account holds a balance of a specific mint for a specific owner.
 * The v1 layout is fixed at **165 bytes**:
 *
 *     offset  size  field
 *     ------  ----  -----
 *     0       32    mint              (Pubkey)
 *     32      32    owner             (Pubkey)
 *     64      8     amount            (u64, little-endian)
 *     72      36    delegate          (COption<Pubkey>: 4-byte tag + 32-byte key)
 *     108     1     state             (u8: 0=uninit, 1=init, 2=frozen)
 *     109     12    isNative          (COption<u64>: 4-byte tag + 8-byte u64)
 *     121     8     delegatedAmount   (u64)
 *     129     36    closeAuthority    (COption<Pubkey>)
 *     ------  ----
 *     total   165
 *
 * Note: like in mint layouts, SPL's `COption<T>` uses a four-byte
 * little-endian tag (not the single byte Borsh `Option<T>` would). The
 * padding bytes are ALWAYS consumed whether the tag is 0 or 1.
 *
 * Token-2022 accounts follow the same 165-byte base layout and then, at
 * byte 165, carry an account-type discriminator followed by TLV entries. The
 * T25 extensions decoder ({@link ./token-2022-extensions}) handles that
 * region; this file populates only the fixed base fields plus
 * {@link TokenAccount.tokenProgram}.
 *
 * Zero ecosystem-SDK deps: only `@ap3x/solana-core`.
 */

import { borsh, PublicKey } from '@ap3x/solana-core';

import {
  detectTokenProgram,
  type AccountInfo,
  type TokenProgramKind,
} from './program-ids';
import { readCOptionPubkey } from './mint';

/** Fixed SPL token account data length, in bytes. */
export const TOKEN_ACCOUNT_SIZE = 165;

/**
 * SPL account-state discriminant byte values.
 *
 * We export them as a union of string literals for the public type, but use
 * the raw byte values when parsing. `'uninitialized'` (byte 0) means the
 * account was never initialised; `'frozen'` (byte 2) means the mint's
 * freeze authority has frozen it and transfers out are disallowed.
 */
export type TokenAccountState = 'uninitialized' | 'initialized' | 'frozen';

/**
 * Known Token-2022 account-side extension values. Populated by
 * {@link ./token-2022-extensions}; T24 never fills this field.
 */
export type TokenAccountExtensionsLike = Record<string, unknown>;

/** A TLV entry we couldn't decode into a known account extension shape. */
export interface UnknownTokenAccountExtension {
  /** Extension type ID (u16). */
  type: number;
  /** Raw extension payload bytes. */
  data: Uint8Array;
}

/**
 * Decoded SPL Token Account. All `COption<Pubkey>` fields become `null`
 * when the SPL tag is zero.
 *
 *   - `isNative` is `bigint | null` — when Some, it carries the rent-exempt
 *     reserve (for wSOL-style wrapped native accounts). When None, the
 *     account is a regular SPL token account.
 */
export interface TokenAccount {
  mint: PublicKey;
  owner: PublicKey;
  /** Current balance, as a raw u64 (no decimal scaling applied). */
  amount: bigint;
  /** Account allowed to move `delegatedAmount` on behalf of the owner. */
  delegate: PublicKey | null;
  /** Current account state — initialisation / frozen flag. */
  state: TokenAccountState;
  /**
   * For wrapped native tokens (wSOL), the rent-exempt reserve in lamports.
   * `null` for non-native SPL token accounts.
   */
  isNative: bigint | null;
  /** Amount the delegate is authorised to spend; 0 when no delegate is set. */
  delegatedAmount: bigint;
  /** Account allowed to close this token account; `null` when absent. */
  closeAuthority: PublicKey | null;
  /** Which SPL Token flavour owns the account (`detectTokenProgram`). */
  tokenProgram: TokenProgramKind;
  /**
   * Known Token-2022 extension values. Only populated by the extensions
   * module; absent otherwise. Empty object means "Token-2022 account with no
   * recognized extensions".
   */
  extensions?: TokenAccountExtensionsLike;
  /**
   * TLV entries we couldn't decode into {@link extensions}. Same population
   * rules.
   */
  unknownExtensions?: UnknownTokenAccountExtension[];
}

/**
 * Read an SPL `COption<u64>` — 4-byte LE tag followed by an 8-byte u64. Tag
 * = 0 → `null` (and we consume the u64 slot as zero); tag = 1 → return the
 * u64. Any other tag throws.
 */
function readCOptionU64(r: borsh.Reader, field: string): bigint | null {
  const tag = r.readU32();
  const value = r.readU64();
  if (tag === 0) return null;
  if (tag === 1) return value;
  throw new Error(
    `decodeTokenAccount: invalid COption<u64> tag ${tag} for ${field} — expected 0 or 1`,
  );
}

/**
 * Map the raw state byte to its string-literal label. Any byte other than
 * 0/1/2 throws — the SPL layout does not define other values and treating
 * unknown ones as "initialized" would silently hide corruption.
 */
function stateFromByte(b: number): TokenAccountState {
  if (b === 0) return 'uninitialized';
  if (b === 1) return 'initialized';
  if (b === 2) return 'frozen';
  throw new Error(
    `decodeTokenAccount: invalid state byte ${b} — expected 0 (uninit), 1 (init), or 2 (frozen)`,
  );
}

/**
 * Decode an SPL Token Account.
 *
 * @throws Error if `account.data.length < 165`
 * @throws Error if a COption tag is neither 0 nor 1
 * @throws Error if the state byte is outside `{0, 1, 2}`
 */
export function decodeTokenAccount(account: AccountInfo): TokenAccount {
  if (account.data.length < TOKEN_ACCOUNT_SIZE) {
    throw new Error(
      `decodeTokenAccount: data too short — got ${account.data.length} bytes, need at least ${TOKEN_ACCOUNT_SIZE}`,
    );
  }

  // Slice off the extension region before parsing, so a malformed extension
  // section can't cause a base-field read to tumble into padding bytes.
  const base = account.data.subarray(0, TOKEN_ACCOUNT_SIZE);
  const r = new borsh.Reader(base);

  const mint = r.readPubkey();
  const owner = r.readPubkey();
  const amount = r.readU64();
  const delegate = readCOptionPubkey(r, 'delegate');
  const state = stateFromByte(r.readU8());
  const isNative = readCOptionU64(r, 'isNative');
  const delegatedAmount = r.readU64();
  const closeAuthority = readCOptionPubkey(r, 'closeAuthority');

  const tokenProgram = detectTokenProgram(account);

  return {
    mint,
    owner,
    amount,
    delegate,
    state,
    isNative,
    delegatedAmount,
    closeAuthority,
    tokenProgram,
  };
}
