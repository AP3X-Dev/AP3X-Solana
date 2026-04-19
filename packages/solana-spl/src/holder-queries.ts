/**
 * Typed wrappers over {@link RpcPool.call} for common SPL holder queries.
 *
 * The underlying RPC methods:
 *
 *   - `getTokenLargestAccounts` — returns up to 20 highest-balance
 *     accounts for a mint. No pagination; the JSON-RPC always returns the
 *     full list in one shot. Output shape:
 *       `{ context: {...}, value: Array<{ address, amount, decimals, uiAmountString }> }`
 *
 *   - `getProgramAccounts` with a size + memcmp filter — returns all token
 *     accounts for a given mint. We encode the mint pubkey as the memcmp
 *     value at offset 0 (the mint field lives at the start of the 165-byte
 *     token account layout). The RPC can be slow on high-cardinality
 *     mints; callers that need large sets should hit a specialised
 *     indexer instead.
 *
 * Both functions do best-effort parsing and surface partial results rather
 * than throwing when only some entries are malformed — but they DO throw on
 * envelope-level shape mismatches (wrong `value` type, missing fields,
 * etc.) to fail loudly on a real protocol change.
 *
 * Zero ecosystem-SDK deps: only `@ap3x/solana-core` (PublicKey, base58) and
 * a nominal dependency on `@ap3x/solana-connectivity` for the RpcPool
 * type. The RpcPool itself is threaded in as a parameter so callers with
 * their own RPC setup can plug in a compatible shape.
 */

import { PublicKey } from '@ap3x/solana-core';

import {
  TOKEN_ACCOUNT_SIZE,
  decodeTokenAccount,
  type TokenAccount,
} from './token-account';
import { TOKEN_PROGRAM_ID } from './program-ids';

// ---------------------------------------------------------------------------
// Minimal RpcPool shape — matches `@ap3x/solana-connectivity`'s `RpcPool`
// without pulling its type in directly. Any object with a compatible
// `call` method works — in particular the connectivity package's
// `RpcPool`, but also test doubles.
// ---------------------------------------------------------------------------

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface RpcPoolLike {
  call(
    method: string,
    params: unknown[] | Record<string, unknown>,
    opts?: { commitment?: Commitment; signal?: AbortSignal },
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// getTokenLargestAccounts
// ---------------------------------------------------------------------------

/** One entry in the `getTokenLargestAccounts` response. */
export interface LargestAccount {
  /** Token account address — NOT the owner of that account. */
  address: PublicKey;
  /** Balance in raw base units (no decimal scaling). */
  amount: bigint;
  /** Mint's `decimals` field, repeated here by the RPC for convenience. */
  decimals: number;
}

/**
 * Return up to 20 highest-balance accounts for a given mint.
 *
 * The RPC returns at most 20 entries (hard-coded on the validator side);
 * callers asking for more should use an indexer.
 *
 * @throws Error if the response envelope shape is unexpected.
 */
export async function getTokenLargestAccounts(
  rpcPool: RpcPoolLike,
  mint: PublicKey,
  commitment?: Commitment,
): Promise<LargestAccount[]> {
  const params: unknown[] = [mint.toBase58()];
  if (commitment !== undefined) {
    params.push({ commitment });
  }
  const raw = await rpcPool.call('getTokenLargestAccounts', params);

  // The response is `{ context: {...}, value: [{ address, amount, decimals, ... }] }`.
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      'getTokenLargestAccounts: unexpected response envelope (not an object)',
    );
  }
  const value = (raw as { value?: unknown }).value;
  if (!Array.isArray(value)) {
    throw new Error(
      'getTokenLargestAccounts: response.value is not an array',
    );
  }

  return value.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `getTokenLargestAccounts: entry[${i}] is not an object`,
      );
    }
    const e = entry as {
      address?: unknown;
      amount?: unknown;
      decimals?: unknown;
    };
    if (typeof e.address !== 'string') {
      throw new Error(
        `getTokenLargestAccounts: entry[${i}].address is not a string`,
      );
    }
    if (typeof e.amount !== 'string') {
      throw new Error(
        `getTokenLargestAccounts: entry[${i}].amount is not a string`,
      );
    }
    if (typeof e.decimals !== 'number') {
      throw new Error(
        `getTokenLargestAccounts: entry[${i}].decimals is not a number`,
      );
    }
    return {
      address: PublicKey.fromBase58(e.address),
      amount: BigInt(e.amount),
      decimals: e.decimals,
    };
  });
}

// ---------------------------------------------------------------------------
// getTokenAccountsByMint (via getProgramAccounts + filters)
// ---------------------------------------------------------------------------

/** One decoded token account returned from {@link getTokenAccountsByMint}. */
export interface TokenAccountHolding {
  /** The account's on-chain address. */
  pubkey: PublicKey;
  /** Fully-decoded token account (base v1 fields). */
  account: TokenAccount;
}

export interface GetTokenAccountsByMintOptions {
  commitment?: Commitment;
  /**
   * Which SPL Token program to query under. Defaults to Token v1 —
   * Token-2022 mints should pass `TOKEN_2022_PROGRAM_ID`.
   */
  tokenProgramId?: PublicKey;
}

/**
 * Enumerate every token account holding a given mint, fully decoded.
 *
 * Uses `getProgramAccounts` with two filters:
 *   - `dataSize = 165` — restrict to the v1 token-account layout so we
 *     don't pull back arbitrary program data.
 *   - `memcmp { offset: 0, bytes: base58(mint) }` — match the mint field
 *     stored at offset 0 of every token account.
 *
 * Requests `encoding: base64` so we can decode the raw bytes directly via
 * `decodeTokenAccount`. `jsonParsed` would force us to depend on the
 * validator's SPL-specific parsing, which we deliberately do not.
 *
 * The underlying RPC is heavy — validators throttle or outright reject
 * requests for high-cardinality mints. Callers with strict performance
 * requirements should integrate with an indexer instead of polling this.
 */
export async function getTokenAccountsByMint(
  rpcPool: RpcPoolLike,
  mint: PublicKey,
  options: GetTokenAccountsByMintOptions = {},
): Promise<TokenAccountHolding[]> {
  const tokenProgramId = options.tokenProgramId ?? TOKEN_PROGRAM_ID;
  const config: Record<string, unknown> = {
    encoding: 'base64',
    filters: [
      { dataSize: TOKEN_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: mint.toBase58() } },
    ],
  };
  if (options.commitment !== undefined) {
    config.commitment = options.commitment;
  }

  const raw = await rpcPool.call('getProgramAccounts', [
    tokenProgramId.toBase58(),
    config,
  ]);

  if (!Array.isArray(raw)) {
    throw new Error(
      'getTokenAccountsByMint: response is not an array (expected getProgramAccounts shape)',
    );
  }

  const out: TokenAccountHolding[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `getTokenAccountsByMint: entry[${i}] is not an object`,
      );
    }
    const e = entry as { pubkey?: unknown; account?: unknown };
    if (typeof e.pubkey !== 'string') {
      throw new Error(
        `getTokenAccountsByMint: entry[${i}].pubkey is not a string`,
      );
    }
    if (!e.account || typeof e.account !== 'object') {
      throw new Error(
        `getTokenAccountsByMint: entry[${i}].account is not an object`,
      );
    }
    const acc = e.account as { data?: unknown; owner?: unknown };
    // `data` is `[base64String, 'base64']` when encoding: 'base64'. We only
    // use the payload — the encoding label is redundant here.
    if (!Array.isArray(acc.data) || typeof acc.data[0] !== 'string') {
      throw new Error(
        `getTokenAccountsByMint: entry[${i}].account.data must be [string, 'base64']`,
      );
    }
    const dataBytes = base64ToBytes(acc.data[0]);
    const ownerPk =
      typeof acc.owner === 'string'
        ? PublicKey.fromBase58(acc.owner)
        : tokenProgramId;
    const decoded = decodeTokenAccount({ data: dataBytes, owner: ownerPk });
    out.push({
      pubkey: PublicKey.fromBase58(e.pubkey),
      account: decoded,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string into a Uint8Array without pulling in Node's
 * `Buffer` directly, because Buffer is Node-only and we want the code to
 * stay browser-capable. Node exposes `atob` via the global since v16 so it
 * works uniformly.
 */
function base64ToBytes(b64: string): Uint8Array {
  // eslint-disable-next-line no-undef
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

