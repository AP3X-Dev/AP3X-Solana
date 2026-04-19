/**
 * Canonical Solana token program IDs + shared types used by both
 * {@link ./mint} and {@link ./token-account}.
 *
 * These IDs are immutable and come straight from the Solana SPL spec. We
 * decode them once at module load so every caller shares the same
 * {@link PublicKey} instance — equality checks reduce to `.equals()` against
 * a single object.
 *
 * Zero ecosystem-SDK deps: the PublicKey class comes from `@ap3x/solana-core`.
 */

import { PublicKey } from '@ap3x/solana-core';

/**
 * SPL Token v1 program ID (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
 *
 * This is the "classic" SPL token program that holds the vast majority of
 * Solana fungible tokens. Accounts whose `owner` equals this ID follow the
 * v1 layout with no TLV extensions.
 */
export const TOKEN_PROGRAM_ID = /* @__PURE__ */ PublicKey.fromBase58(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/**
 * SPL Token-2022 program ID (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
 *
 * Token-2022 extends the v1 layout with a TLV extension region after the
 * base bytes (see {@link ../token-2022-extensions}). Detection is by
 * `account.owner` equality.
 */
export const TOKEN_2022_PROGRAM_ID = /* @__PURE__ */ PublicKey.fromBase58(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

/**
 * Associated Token Account program ID
 * (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`). Used by
 * {@link ../ata.getAssociatedTokenAddress} as the PDA's program ID input.
 */
export const ASSOCIATED_TOKEN_PROGRAM_ID = /* @__PURE__ */ PublicKey.fromBase58(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/** Solana System Program ID — required account in ATA-create instructions. */
export const SYSTEM_PROGRAM_ID = /* @__PURE__ */ PublicKey.fromBase58(
  '11111111111111111111111111111111',
);

/**
 * Which SPL Token flavour owns an account. Decoded mints + token accounts
 * carry this tag so downstream code can branch on it without re-inspecting
 * program IDs.
 */
export type TokenProgramKind = 'spl-v1' | 'token-2022';

/**
 * Minimal account-info shape the decoder functions consume. Callers usually
 * pass the result of `rpcPool.call('getAccountInfo', ...)` after light
 * normalization, but the shape is intentionally structural so tests can
 * construct accounts directly from bytes without plumbing through RPC types.
 *
 * `owner` is optional because some decode callers only have the raw data
 * (e.g. reading directly from a Geyser account update); when absent the
 * decoder defaults to `'spl-v1'` and cannot detect Token-2022 extensions.
 */
export interface AccountInfo {
  /** Raw account data bytes. */
  data: Uint8Array;
  /**
   * Program ID that owns the account. Determines which token flavour the
   * decoder reports. When omitted, decoders conservatively default to
   * `'spl-v1'` and skip extension parsing.
   */
  owner?: PublicKey;
}

/**
 * Decide which SPL Token flavour owns an account by checking `account.owner`
 * against the Token-2022 program ID. Anything else (including missing
 * owner) is reported as `'spl-v1'` — that matches how the Solana runtime
 * itself distinguishes the two.
 */
export function detectTokenProgram(account: AccountInfo): TokenProgramKind {
  if (account.owner && account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return 'token-2022';
  }
  return 'spl-v1';
}
