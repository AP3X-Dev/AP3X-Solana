import { describe, it, expect, vi } from 'vitest';
import { Buffer } from 'node:buffer';

import { PublicKey } from '@ap3x/solana-core';

import {
  getTokenAccountsByMint,
  getTokenLargestAccounts,
  type RpcPoolLike,
} from './holder-queries';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './program-ids';
import { TOKEN_ACCOUNT_SIZE } from './token-account';

// Helper — build a mock RpcPool whose `call` returns a preset value and
// captures the arguments for later inspection.
function mockPool(response: unknown): RpcPoolLike & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    call: vi.fn(async (method: string, params: unknown, opts?: unknown) => {
      calls.push([method, params, opts]);
      return response;
    }),
  };
}

// ---------------------------------------------------------------------------
// getTokenLargestAccounts
// ---------------------------------------------------------------------------

const WSOL_MINT = PublicKey.fromBase58(
  'So11111111111111111111111111111111111111112',
);
const OWNER_A = PublicKey.fromBase58(
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
);

describe('getTokenLargestAccounts', () => {
  it('calls getTokenLargestAccounts with the mint as a single positional param', async () => {
    const pool = mockPool({
      context: { slot: 123 },
      value: [
        {
          address: OWNER_A.toBase58(),
          amount: '1000000',
          decimals: 6,
          uiAmount: 1,
          uiAmountString: '1',
        },
      ],
    });
    const result = await getTokenLargestAccounts(pool, WSOL_MINT);
    expect(pool.calls).toEqual([
      ['getTokenLargestAccounts', [WSOL_MINT.toBase58()], undefined],
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.address.toBase58()).toBe(OWNER_A.toBase58());
    expect(result[0]!.amount).toBe(1_000_000n);
    expect(result[0]!.decimals).toBe(6);
  });

  it('appends commitment as a second param when provided', async () => {
    const pool = mockPool({ context: {}, value: [] });
    await getTokenLargestAccounts(pool, WSOL_MINT, 'finalized');
    expect(pool.calls[0]).toEqual([
      'getTokenLargestAccounts',
      [WSOL_MINT.toBase58(), { commitment: 'finalized' }],
      undefined,
    ]);
  });

  it('preserves entry order as returned by the RPC', async () => {
    const pool = mockPool({
      context: {},
      value: [
        { address: OWNER_A.toBase58(), amount: '5', decimals: 0 },
        { address: WSOL_MINT.toBase58(), amount: '3', decimals: 0 },
      ],
    });
    const result = await getTokenLargestAccounts(pool, WSOL_MINT);
    expect(result.map((r) => r.amount.toString())).toEqual(['5', '3']);
  });

  it('throws when the response envelope is not an object', async () => {
    const pool = mockPool('not-an-object');
    await expect(getTokenLargestAccounts(pool, WSOL_MINT)).rejects.toThrow(
      /unexpected response envelope/,
    );
  });

  it('throws when response.value is not an array', async () => {
    const pool = mockPool({ value: 'nope' });
    await expect(getTokenLargestAccounts(pool, WSOL_MINT)).rejects.toThrow(
      /value is not an array/,
    );
  });

  it('throws when an entry is missing required fields', async () => {
    const pool = mockPool({
      context: {},
      value: [{ address: OWNER_A.toBase58() /* no amount, no decimals */ }],
    });
    await expect(getTokenLargestAccounts(pool, WSOL_MINT)).rejects.toThrow(
      /entry\[0\]\.amount/,
    );
  });

  it('throws when entry.address is not a string', async () => {
    const pool = mockPool({
      context: {},
      value: [{ address: 123, amount: '1', decimals: 0 }],
    });
    await expect(getTokenLargestAccounts(pool, WSOL_MINT)).rejects.toThrow(
      /entry\[0\]\.address/,
    );
  });

  it('throws when entry.decimals is not a number', async () => {
    const pool = mockPool({
      context: {},
      value: [{ address: OWNER_A.toBase58(), amount: '1', decimals: '0' }],
    });
    await expect(getTokenLargestAccounts(pool, WSOL_MINT)).rejects.toThrow(
      /entry\[0\]\.decimals/,
    );
  });

  it('throws when an entry is null', async () => {
    const pool = mockPool({ context: {}, value: [null] });
    await expect(getTokenLargestAccounts(pool, WSOL_MINT)).rejects.toThrow(
      /entry\[0\] is not an object/,
    );
  });
});

// ---------------------------------------------------------------------------
// getTokenAccountsByMint
// ---------------------------------------------------------------------------

/**
 * Build a synthetic base64-encoded 165-byte token account whose mint field
 * matches the caller-supplied mint. We stamp deterministic bytes into the
 * owner and amount so the round-trip checks have something concrete to
 * assert on.
 */
function synthAccountBase64(mint: PublicKey, owner: PublicKey, amount: bigint): string {
  const buf = new Uint8Array(TOKEN_ACCOUNT_SIZE);
  buf.set(mint.toBuffer(), 0);
  buf.set(owner.toBuffer(), 32);
  const view = new DataView(buf.buffer);
  view.setBigUint64(64, amount, true);
  buf[108] = 0x01; // state = initialized
  return Buffer.from(buf).toString('base64');
}

describe('getTokenAccountsByMint', () => {
  it('calls getProgramAccounts with correct size + memcmp filters', async () => {
    const pool = mockPool([]);
    await getTokenAccountsByMint(pool, WSOL_MINT);
    expect(pool.calls[0]![0]).toBe('getProgramAccounts');
    const [, params] = pool.calls[0]!;
    expect(Array.isArray(params)).toBe(true);
    const [programArg, config] = params as [string, Record<string, unknown>];
    expect(programArg).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(config.encoding).toBe('base64');
    expect(config.filters).toEqual([
      { dataSize: TOKEN_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: WSOL_MINT.toBase58() } },
    ]);
  });

  it('passes commitment through when supplied', async () => {
    const pool = mockPool([]);
    await getTokenAccountsByMint(pool, WSOL_MINT, { commitment: 'confirmed' });
    const [, params] = pool.calls[0]!;
    const [, config] = params as [string, Record<string, unknown>];
    expect(config.commitment).toBe('confirmed');
  });

  it('routes custom tokenProgramId through (Token-2022)', async () => {
    const pool = mockPool([]);
    await getTokenAccountsByMint(pool, WSOL_MINT, {
      tokenProgramId: TOKEN_2022_PROGRAM_ID,
    });
    const [, params] = pool.calls[0]!;
    const [programArg] = params as [string, Record<string, unknown>];
    expect(programArg).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it('decodes returned entries into TokenAccountHolding records', async () => {
    const accountData = synthAccountBase64(WSOL_MINT, OWNER_A, 42_000_000n);
    const accountPubkey = 'ALZv1FW3Bc5uRtci2UHnYS34DEWCmfkN5btEYDKms9yU';
    const pool = mockPool([
      {
        pubkey: accountPubkey,
        account: {
          lamports: 2_039_280,
          owner: TOKEN_PROGRAM_ID.toBase58(),
          executable: false,
          rentEpoch: 0,
          data: [accountData, 'base64'],
        },
      },
    ]);
    const result = await getTokenAccountsByMint(pool, WSOL_MINT);
    expect(result).toHaveLength(1);
    expect(result[0]!.pubkey.toBase58()).toBe(accountPubkey);
    expect(result[0]!.account.mint.equals(WSOL_MINT)).toBe(true);
    expect(result[0]!.account.owner.equals(OWNER_A)).toBe(true);
    expect(result[0]!.account.amount).toBe(42_000_000n);
    expect(result[0]!.account.state).toBe('initialized');
  });

  it('throws when the response is not an array', async () => {
    const pool = mockPool({ value: [] });
    await expect(getTokenAccountsByMint(pool, WSOL_MINT)).rejects.toThrow(
      /is not an array/,
    );
  });

  it("throws when an entry.data isn't [base64, 'base64']", async () => {
    const pool = mockPool([
      {
        pubkey: OWNER_A.toBase58(),
        account: { data: 'jsonParsed-style', owner: TOKEN_PROGRAM_ID.toBase58() },
      },
    ]);
    await expect(getTokenAccountsByMint(pool, WSOL_MINT)).rejects.toThrow(
      /must be \[string, 'base64'\]/,
    );
  });

  it('throws on missing pubkey or account', async () => {
    const pool = mockPool([{ /* empty */ }]);
    await expect(getTokenAccountsByMint(pool, WSOL_MINT)).rejects.toThrow(
      /entry\[0\]\.pubkey/,
    );
  });

  it('throws when an entry is null or not an object', async () => {
    const pool = mockPool([null]);
    await expect(getTokenAccountsByMint(pool, WSOL_MINT)).rejects.toThrow(
      /entry\[0\] is not an object/,
    );
  });

  it('throws when entry.account is null or not an object', async () => {
    const pool = mockPool([{ pubkey: OWNER_A.toBase58(), account: null }]);
    await expect(getTokenAccountsByMint(pool, WSOL_MINT)).rejects.toThrow(
      /entry\[0\]\.account is not an object/,
    );
  });

  it('falls back to tokenProgramId when entry.account.owner is missing', async () => {
    // Some RPCs trim `owner` on the account record; our decoder should
    // still work because we default to the queried program ID.
    const accountData = synthAccountBase64(WSOL_MINT, OWNER_A, 1n);
    const pool = mockPool([
      {
        pubkey: OWNER_A.toBase58(),
        account: { data: [accountData, 'base64'] },
      },
    ]);
    const result = await getTokenAccountsByMint(pool, WSOL_MINT);
    expect(result[0]!.account.tokenProgram).toBe('spl-v1');
  });
});
