/**
 * Token-2022 TLV extension parser.
 *
 * Token-2022 accounts (both mints and token accounts) carry optional
 * extension data after the v1 base layout. The wire format is:
 *
 *     offset   size  field
 *     -------  ----  -----
 *     0        82    Mint base (or 165 for TokenAccount)
 *     ...      ...   padding (Mints only — pads the base out to 165 bytes)
 *     165      1     account_type discriminator
 *                      0 = Uninitialized
 *                      1 = Mint
 *                      2 = Account
 *     166      *     TLV entries
 *
 * Each TLV entry:
 *
 *     u16 LE  type
 *     u16 LE  length (in bytes, not including this 4-byte header)
 *     [length]   data
 *
 * The list terminates at one of:
 *   - The end of `data`.
 *   - A TLV entry with `type = 0` (Uninitialized), which Token-2022 uses as a
 *     pseudo-terminator.
 *
 * **Why the Mint side pads to 165:** Mint and TokenAccount share the same
 * TLV layout so the runtime can read either with a single cursor. Without
 * the pad, a Mint with extensions would have its account_type byte at 82 and
 * an Account's at 165, forcing branchy decoding. The pad unifies them at
 * offset 165.
 *
 * A Token-2022 **Mint without any extensions** is typically serialized at
 * exactly 82 bytes (the bare v1 layout). In that case there is no
 * account_type discriminator and no TLV region to parse. TokenAccounts
 * similarly can be exactly 165 bytes.
 *
 * Only a small set of extension types are decoded into structured shapes:
 *
 *   - `MintCloseAuthority` (type 3, mint-side)
 *   - `TransferFeeConfig` (type 1, mint-side)
 *   - `DefaultAccountState` (type 6, mint-side)
 *
 * Everything else we see — including account-side extensions and mint-side
 * extensions we haven't decoded yet — surfaces as an entry in
 * `unknownExtensions`, not silently dropped. That's the "unknown variants
 * emit typed records" invariant from the PRP conventions.
 *
 * Zero ecosystem-SDK deps: only `@ap3x/solana-core`.
 */

import { borsh, PublicKey } from '@ap3x/solana-core';

import {
  detectTokenProgram,
  type AccountInfo,
} from './program-ids';

/**
 * Offset at which the account_type discriminator sits in Token-2022
 * accounts. Equal to `TOKEN_ACCOUNT_SIZE`, so a 165-byte account has no
 * byte at this offset and therefore no TLV region.
 */
export const ACCOUNT_TYPE_OFFSET = 165;
export const TLV_START_OFFSET = 166;

/** account_type discriminator values. */
export const ACCOUNT_TYPE_UNINITIALIZED = 0;
export const ACCOUNT_TYPE_MINT = 1;
export const ACCOUNT_TYPE_ACCOUNT = 2;

/** Known Token-2022 extension type IDs (u16 values). */
export const EXTENSION_TYPE = Object.freeze({
  Uninitialized: 0,
  TransferFeeConfig: 1,
  TransferFeeAmount: 2,
  MintCloseAuthority: 3,
  ConfidentialTransferMint: 4,
  ConfidentialTransferAccount: 5,
  DefaultAccountState: 6,
  ImmutableOwner: 7,
  MemoTransfer: 8,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  CpiGuard: 11,
  PermanentDelegate: 12,
  TransferHook: 13,
  TransferHookAccount: 14,
  ConfidentialTransferFeeConfig: 15,
  ConfidentialTransferFeeAmount: 16,
  MetadataPointer: 17,
  TokenMetadata: 18,
  GroupPointer: 19,
  TokenGroup: 20,
  GroupMemberPointer: 21,
  TokenGroupMember: 22,
} as const);

/** A TLV entry we parsed but didn't decode into a structured shape. */
export interface UnknownExtension {
  /** Extension type ID (u16). */
  type: number;
  /** Raw extension payload bytes (excluding the 4-byte header). */
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Known extension shapes (mint side)
// ---------------------------------------------------------------------------

/** {@link EXTENSION_TYPE.MintCloseAuthority} decoded payload. */
export interface MintCloseAuthorityExt {
  /** Authority allowed to close the mint; `null` when revoked / unset. */
  closeAuthority: PublicKey | null;
}

/** A single fee tier carried inside {@link TransferFeeConfigExt}. */
export interface TransferFee {
  /** Epoch at which this fee schedule takes effect. */
  epoch: bigint;
  /** Cap on fee amount, in raw token base units. */
  maximumFee: bigint;
  /** Fee size in basis points (1 bp = 0.01%). */
  transferFeeBasisPoints: number;
}

/**
 * {@link EXTENSION_TYPE.TransferFeeConfig} decoded payload.
 *
 * Token-2022 supports scheduling a fee update by storing TWO fee schedules:
 * the `olderTransferFee` applies until its `epoch` is reached, then
 * `newerTransferFee` takes over. Both are always present in the layout
 * (zeroed-out older schedule is valid).
 */
export interface TransferFeeConfigExt {
  transferFeeConfigAuthority: PublicKey | null;
  withdrawWithheldAuthority: PublicKey | null;
  /** Sum of fees withheld across all accounts, not yet harvested to the mint. */
  withheldAmount: bigint;
  olderTransferFee: TransferFee;
  newerTransferFee: TransferFee;
}

/** {@link EXTENSION_TYPE.DefaultAccountState} decoded payload. */
export interface DefaultAccountStateExt {
  /** Default state applied to freshly-created token accounts of this mint. */
  state: 'uninitialized' | 'initialized' | 'frozen';
}

/**
 * Known Token-2022 extension values decoded from a Mint's TLV region. Only
 * the extensions we recognize become typed fields; everything else surfaces
 * in `unknownExtensions`.
 */
export interface TokenMintExtensions {
  mintCloseAuthority?: MintCloseAuthorityExt;
  transferFeeConfig?: TransferFeeConfigExt;
  defaultAccountState?: DefaultAccountStateExt;
}

/**
 * Known Token-2022 extension values decoded from a TokenAccount's TLV
 * region. T25 doesn't decode any account-side extensions to structured
 * shapes — known ones still surface as unknown records with their type ID.
 */
export interface TokenAccountExtensions {
  // Intentionally empty for T25 — all account-side extensions route through
  // `unknownExtensions`. Leave the interface open for future T25+ work.
}

// ---------------------------------------------------------------------------
// Public decode entry point
// ---------------------------------------------------------------------------

export interface DecodedExtensions<
  E extends TokenMintExtensions | TokenAccountExtensions,
> {
  extensions: E;
  unknownExtensions: UnknownExtension[];
}

/**
 * Decode the Token-2022 TLV region of an account.
 *
 * `accountKind` tells us which base layout size to use when locating the
 * account_type byte and the start of the TLV region. For `'mint'` we expect
 * (but don't enforce) that bytes 82..165 are padding; for `'account'` the
 * base is already 165 bytes and there is no padding.
 *
 * Returns `{ extensions: {}, unknownExtensions: [] }` when:
 *   - The data is too short to contain a TLV region.
 *   - The account_type discriminator is `0` (Uninitialized) — this marks
 *     an account that has the extension layout reserved but nothing stored.
 */
export function decodeExtensions<
  K extends 'mint' | 'account',
>(
  data: Uint8Array,
  accountKind: K,
): DecodedExtensions<
  K extends 'mint' ? TokenMintExtensions : TokenAccountExtensions
> {
  // If there is no room for the account_type byte, there's no TLV region.
  if (data.length <= ACCOUNT_TYPE_OFFSET) {
    return {
      extensions: {} as K extends 'mint'
        ? TokenMintExtensions
        : TokenAccountExtensions,
      unknownExtensions: [],
    };
  }

  // Sanity: the account_type byte should match the caller's intent. We
  // don't hard-fail on mismatch because Token-2022 has an `Uninitialized`
  // account_type too, and defensive-decoding should still produce a
  // consistent empty result rather than throwing.
  const accountType = data[ACCOUNT_TYPE_OFFSET]!;
  if (accountType === ACCOUNT_TYPE_UNINITIALIZED) {
    return {
      extensions: {} as K extends 'mint'
        ? TokenMintExtensions
        : TokenAccountExtensions,
      unknownExtensions: [],
    };
  }

  const tlv = data.subarray(TLV_START_OFFSET);
  const entries = readTlvEntries(tlv);

  const unknownExtensions: UnknownExtension[] = [];
  const mintExtensions: TokenMintExtensions = {};
  // Account extensions are empty for T25; we still build a placeholder so
  // the generic return type is satisfied uniformly.
  const accountExtensions: TokenAccountExtensions = {};

  for (const entry of entries) {
    // Uninitialized marks the end of the TLV stream; readTlvEntries has
    // already stopped at it, but guard here defensively.
    if (entry.type === EXTENSION_TYPE.Uninitialized) continue;

    if (accountKind === 'mint') {
      if (entry.type === EXTENSION_TYPE.MintCloseAuthority) {
        mintExtensions.mintCloseAuthority = decodeMintCloseAuthority(
          entry.data,
        );
        continue;
      }
      if (entry.type === EXTENSION_TYPE.TransferFeeConfig) {
        mintExtensions.transferFeeConfig = decodeTransferFeeConfig(entry.data);
        continue;
      }
      if (entry.type === EXTENSION_TYPE.DefaultAccountState) {
        mintExtensions.defaultAccountState = decodeDefaultAccountState(
          entry.data,
        );
        continue;
      }
    }

    // Anything else — including every account-side extension in T25 — gets
    // surfaced as an unknown record. We copy the data slice so callers
    // can't back-fill mutations into the source buffer.
    unknownExtensions.push({
      type: entry.type,
      data: new Uint8Array(entry.data),
    });
  }

  return {
    extensions: (accountKind === 'mint'
      ? mintExtensions
      : accountExtensions) as K extends 'mint'
      ? TokenMintExtensions
      : TokenAccountExtensions,
    unknownExtensions,
  };
}

/**
 * Convenience wrapper: takes a full {@link AccountInfo}, checks whether the
 * owner is Token-2022, and returns the decoded extensions. For
 * non-Token-2022 accounts we return an empty result without parsing —
 * callers should not populate the `extensions` / `unknownExtensions` fields
 * for those.
 *
 * Not used internally by the T25 decoders (they call {@link decodeExtensions}
 * directly once they know the kind), but handy for callers who want a
 * one-shot API.
 */
export function decodeAccountExtensions(
  account: AccountInfo,
  kind: 'mint' | 'account',
): {
  extensions: TokenMintExtensions | TokenAccountExtensions;
  unknownExtensions: UnknownExtension[];
} | null {
  if (detectTokenProgram(account) !== 'token-2022') return null;
  return decodeExtensions(account.data, kind);
}

// ---------------------------------------------------------------------------
// Per-extension decoders
// ---------------------------------------------------------------------------

/**
 * Decode a `MintCloseAuthority` extension payload — a single
 * `COption<Pubkey>` (36 bytes: 4-byte LE tag + 32-byte pubkey).
 *
 * Technically Token-2022 stores this as a plain `Pubkey` (not `COption`),
 * with the zero pubkey meaning "no authority". We treat an all-zero pubkey
 * as `null` here to mirror the v1 API's conventions.
 */
function decodeMintCloseAuthority(data: Uint8Array): MintCloseAuthorityExt {
  if (data.length < 32) {
    throw new Error(
      `decodeExtensions: MintCloseAuthority payload too short — got ${data.length}, need 32`,
    );
  }
  const bytes = data.subarray(0, 32);
  let allZero = true;
  for (let i = 0; i < 32; i++) {
    if (bytes[i] !== 0) {
      allZero = false;
      break;
    }
  }
  return {
    closeAuthority: allZero ? null : PublicKey.fromBytes(bytes),
  };
}

/**
 * Decode a `TransferFeeConfig` extension payload. Layout:
 *
 *     Pubkey  transferFeeConfigAuthority    (32 bytes, all-zero = null)
 *     Pubkey  withdrawWithheldAuthority     (32 bytes, all-zero = null)
 *     u64     withheldAmount                (8 bytes)
 *     TransferFee  olderTransferFee         (18 bytes)
 *     TransferFee  newerTransferFee         (18 bytes)
 *
 * where `TransferFee` is:
 *
 *     u64  epoch
 *     u64  maximumFee
 *     u16  transferFeeBasisPoints
 *
 * Total payload: 32 + 32 + 8 + 18 + 18 = 108 bytes.
 */
function decodeTransferFeeConfig(data: Uint8Array): TransferFeeConfigExt {
  const EXPECTED = 108;
  if (data.length < EXPECTED) {
    throw new Error(
      `decodeExtensions: TransferFeeConfig payload too short — got ${data.length}, need ${EXPECTED}`,
    );
  }
  const r = new borsh.Reader(data.subarray(0, EXPECTED));
  const configAuthorityBytes = r.readBytes(32);
  const withdrawAuthorityBytes = r.readBytes(32);
  const withheldAmount = r.readU64();
  const older = readTransferFee(r);
  const newer = readTransferFee(r);

  return {
    transferFeeConfigAuthority: isZeroPubkey(configAuthorityBytes)
      ? null
      : PublicKey.fromBytes(configAuthorityBytes),
    withdrawWithheldAuthority: isZeroPubkey(withdrawAuthorityBytes)
      ? null
      : PublicKey.fromBytes(withdrawAuthorityBytes),
    withheldAmount,
    olderTransferFee: older,
    newerTransferFee: newer,
  };
}

function readTransferFee(r: borsh.Reader): TransferFee {
  const epoch = r.readU64();
  const maximumFee = r.readU64();
  const transferFeeBasisPoints = r.readU16();
  return { epoch, maximumFee, transferFeeBasisPoints };
}

function isZeroPubkey(bytes: Uint8Array): boolean {
  for (let i = 0; i < 32; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/**
 * Decode a `DefaultAccountState` extension payload — a single byte matching
 * the SPL account-state discriminator (0 = uninit, 1 = init, 2 = frozen).
 */
function decodeDefaultAccountState(data: Uint8Array): DefaultAccountStateExt {
  if (data.length < 1) {
    throw new Error(
      'decodeExtensions: DefaultAccountState payload missing state byte',
    );
  }
  const b = data[0]!;
  if (b === 0) return { state: 'uninitialized' };
  if (b === 1) return { state: 'initialized' };
  if (b === 2) return { state: 'frozen' };
  throw new Error(
    `decodeExtensions: DefaultAccountState bad state byte ${b} — expected 0, 1, or 2`,
  );
}

// ---------------------------------------------------------------------------
// TLV cursor
// ---------------------------------------------------------------------------

interface TlvEntry {
  type: number;
  data: Uint8Array;
}

/**
 * Walk a TLV byte stream, returning each entry's type + data slice. Stops
 * at:
 *   - End of input.
 *   - An Uninitialized entry (type = 0) — Token-2022 uses this as a list
 *     terminator. We don't treat trailing zero bytes as an error because
 *     the protocol guarantees the stream ends here.
 *
 * A malformed entry (length claims more bytes than remain) throws — silently
 * truncating would be the wrong choice: the chain either stored a valid
 * extension stream or it didn't, and the caller should see the failure.
 *
 * `data` slices returned are subarrays of the input — callers that need
 * ownership should copy before mutating.
 */
function readTlvEntries(data: Uint8Array): TlvEntry[] {
  const out: TlvEntry[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    // Manual little-endian u16 reads — cheaper than spinning up a Reader
    // for each 4-byte header and keeps offsets unambiguous.
    const type = data[offset]! | (data[offset + 1]! << 8);
    const length = data[offset + 2]! | (data[offset + 3]! << 8);
    offset += 4;

    if (type === EXTENSION_TYPE.Uninitialized) {
      // Token-2022 spec: a type=0 entry terminates the list. A well-formed
      // stream has length=0 here, but we don't depend on that.
      break;
    }

    if (offset + length > data.length) {
      throw new Error(
        `decodeExtensions: TLV entry type ${type} length ${length} runs past end of buffer (offset ${offset}, remaining ${data.length - offset})`,
      );
    }
    out.push({ type, data: data.subarray(offset, offset + length) });
    offset += length;
  }
  return out;
}
