/* eslint-disable */
/**
 * Capture live SPL mint + token account fixtures from a provided RPC endpoint.
 *
 * Usage:
 *   RPC_URL=https://... pnpm capture:spl
 *
 * Output:
 *   tests/fixtures/spl-accounts.json.gz
 *
 * Shape (after ungzip):
 *   {
 *     capturedAt: string,              // ISO timestamp
 *     rpcEndpoint: string,             // sanitized URL (token stripped if present in query)
 *     mintCount: number,
 *     tokenAccountCount: number,
 *     mints: Array<{
 *       pubkey: string,
 *       dataBase64: string,
 *       decoded: TokenMint,            // @ap3x/solana-spl decodeMint() output
 *     }>,
 *     tokenAccounts: Array<{
 *       pubkey: string,
 *       dataBase64: string,
 *       decoded: TokenAccount,         // @ap3x/solana-spl decodeTokenAccount() output
 *     }>,
 *   }
 *
 * Notes:
 *   - Zero runtime deps on any @solana/* package — uses @ap3x/solana-connectivity
 *     for RPC transport and @ap3x/solana-spl for decoding, matching production paths.
 *   - Randomly samples down to 500 entries per kind when the live response exceeds that.
 *     The initial getProgramAccounts response for TOKEN_PROGRAM_ID can be very large;
 *     callers should prefer a provider endpoint that accepts dataSize filters.
 *   - Custom JSON replacer handles bigint, Uint8Array (base64), and PublicKey (toBase58).
 */

import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

import { RpcPool, type RpcEndpoint } from '@ap3x/solana-connectivity';
import {
  TOKEN_PROGRAM_ID,
  decodeMint,
  decodeTokenAccount,
} from '@ap3x/solana-spl';

const MINT_DATA_SIZE = 82;
const TOKEN_ACCOUNT_DATA_SIZE = 165;
const SAMPLE_TARGET = 500;

interface RpcAccount {
  pubkey: string;
  account: {
    data: [string, string]; // [base64, 'base64']
    owner: string;
    executable: boolean;
    lamports: number;
    rentEpoch: number;
  };
}

function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Strip query + credential-bearing segments from known providers.
    u.search = '';
    // Helius/QuickNode commonly put an API key as the last path segment; strip anything
    // resembling a hex/uuid token so we never serialise secrets into committed fixtures.
    u.pathname = u.pathname.replace(/\/[A-Za-z0-9_-]{16,}\/?$/, '/<redacted>');
    return u.toString();
  } catch {
    return '<malformed RPC_URL>';
  }
}

function sample<T>(arr: T[], n: number, rng: () => number = Math.random): T[] {
  if (arr.length <= n) return arr.slice();
  const out: T[] = [];
  const used = new Set<number>();
  while (out.length < n) {
    const i = Math.floor(rng() * arr.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(arr[i]!);
  }
  return out;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toBase58?: unknown }).toBase58 === 'function'
  ) {
    return (value as { toBase58: () => string }).toBase58();
  }
  return value;
}

async function fetchProgramAccounts(
  pool: RpcPool,
  programId: string,
  dataSize: number,
): Promise<RpcAccount[]> {
  const result = await pool.call('getProgramAccounts', [
    programId,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [{ dataSize }],
    },
  ]);
  if (!Array.isArray(result)) {
    throw new Error(
      `getProgramAccounts returned non-array response (got ${typeof result})`,
    );
  }
  return result as RpcAccount[];
}

async function main(): Promise<void> {
  const rpcUrl = process.env['RPC_URL'];
  if (!rpcUrl) {
    console.error('RPC_URL env var required. Usage: RPC_URL=https://... pnpm capture:spl');
    process.exit(2);
  }

  const endpoint: RpcEndpoint = {
    name: 'custom',
    url: rpcUrl,
    kind: 'http',
  };
  const pool = new RpcPool({
    endpoints: [endpoint],
    // Fixture capture is a one-shot bulk call; give it a generous timeout since
    // getProgramAccounts for the SPL Token program can take 30-60s on a good endpoint.
    timeoutMs: 120_000,
    retry: { attempts: 2, backoffMs: 1000, jitter: 0.1 },
  });

  const programIdStr = TOKEN_PROGRAM_ID.toBase58();
  console.error(`Fetching SPL mints (dataSize=${MINT_DATA_SIZE})...`);
  const mintsRaw = await fetchProgramAccounts(pool, programIdStr, MINT_DATA_SIZE);
  console.error(`  got ${mintsRaw.length} mints`);

  console.error(`Fetching SPL token accounts (dataSize=${TOKEN_ACCOUNT_DATA_SIZE})...`);
  const tokenRaw = await fetchProgramAccounts(pool, programIdStr, TOKEN_ACCOUNT_DATA_SIZE);
  console.error(`  got ${tokenRaw.length} token accounts`);

  const mintSample = sample(mintsRaw, SAMPLE_TARGET);
  const tokenSample = sample(tokenRaw, SAMPLE_TARGET);

  console.error(`Decoding ${mintSample.length} mints + ${tokenSample.length} token accounts...`);
  const mints = mintSample.map((r) => {
    const data = Buffer.from(r.account.data[0], 'base64');
    return {
      pubkey: r.pubkey,
      dataBase64: r.account.data[0],
      decoded: decodeMint({ data, owner: TOKEN_PROGRAM_ID }),
    };
  });
  const tokenAccounts = tokenSample.map((r) => {
    const data = Buffer.from(r.account.data[0], 'base64');
    return {
      pubkey: r.pubkey,
      dataBase64: r.account.data[0],
      decoded: decodeTokenAccount({ data, owner: TOKEN_PROGRAM_ID }),
    };
  });

  const output = {
    capturedAt: new Date().toISOString(),
    rpcEndpoint: sanitizeUrl(rpcUrl),
    mintCount: mints.length,
    tokenAccountCount: tokenAccounts.length,
    mints,
    tokenAccounts,
  };

  const json = JSON.stringify(output, jsonReplacer, 2);
  const gz = gzipSync(Buffer.from(json, 'utf8'));
  const outPath = 'tests/fixtures/spl-accounts.json.gz';
  await writeFile(outPath, gz);
  console.error(
    `Wrote ${outPath} (${gz.length.toLocaleString()} bytes gzipped, ${json.length.toLocaleString()} bytes raw)`,
  );
  console.error(
    `Captured ${mints.length} mints + ${tokenAccounts.length} token accounts at ${output.capturedAt}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
