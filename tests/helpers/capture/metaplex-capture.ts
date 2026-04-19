/* eslint-disable */
/**
 * Capture live Metaplex Token Metadata fixtures from a provided RPC endpoint.
 *
 * Usage:
 *   RPC_URL=https://... pnpm capture:metaplex
 *
 * Output:
 *   tests/fixtures/metaplex-accounts.json.gz
 *
 * Shape (after ungzip):
 *   {
 *     capturedAt: string,
 *     rpcEndpoint: string,
 *     count: number,
 *     accounts: Array<{
 *       pubkey: string,
 *       dataSize: number,
 *       dataBase64: string,
 *       decoded: MetadataAccount,    // @ap3x/solana-metaplex decodeMetadata() output
 *     }>,
 *   }
 *
 * Strategy:
 *   The Metaplex Token Metadata program (metaqbx...) owns tens of millions of
 *   accounts on mainnet; an unfiltered getProgramAccounts would never return.
 *   To get a mix of v1 / v1.3 / current layouts, we query with a memcmp filter
 *   on byte 0 = `key` discriminator (4 = MetadataV1 — the only type we decode)
 *   combined with `dataSlice` to cap response size, then sample 200 accounts.
 *
 *   Not every provider accepts getProgramAccounts against the metadata program
 *   without a paid plan. This script fails fast with a readable error if the
 *   response is rejected.
 */

import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

import { RpcPool, type RpcEndpoint } from '@ap3x/solana-connectivity';
import {
  METADATA_PROGRAM_ID,
  decodeMetadata,
} from '@ap3x/solana-metaplex';

const SAMPLE_TARGET = 200;

/** `key` discriminator byte 0 = 4 is the only MetadataV1-family variant we decode. */
const METADATA_KEY_DISCRIMINATOR = 4;

/**
 * Typical on-chain data sizes for the MetadataV1 layouts. The decoder auto-detects
 * version from the trailing optional blocks, but narrowing the RPC response keeps
 * the capture tractable and gives us a mix of layouts:
 *
 *   - 679: v1 (puffed) — name/symbol/uri padded to MAX lengths, no editionNonce.
 *   - 607: v1.1+ — includes COption<editionNonce>.
 *   - 688: v1.3 — + COption<CollectionDetails>.
 *   - 722: current (pNFT) — + COption<ProgrammableConfig>.
 *
 * We submit one request per size, concat, de-dup by pubkey, then sample.
 */
const CANDIDATE_DATA_SIZES = [679, 688, 722];

interface RpcAccount {
  pubkey: string;
  account: {
    data: [string, string];
    owner: string;
    executable: boolean;
    lamports: number;
    rentEpoch: number;
  };
}

function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = '';
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

async function fetchByDataSize(
  pool: RpcPool,
  programId: string,
  dataSize: number,
): Promise<RpcAccount[]> {
  const result = await pool.call('getProgramAccountsV2', [
    programId,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      limit: 200,
      filters: [
        { dataSize },
        {
          memcmp: {
            offset: 0,
            bytes: base58EncodeByte(METADATA_KEY_DISCRIMINATOR),
          },
        },
      ],
    },
  ]) as { accounts?: RpcAccount[] } | RpcAccount[];
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.accounts)) return result.accounts;
  throw new Error(
    `getProgramAccountsV2(dataSize=${dataSize}) returned unexpected shape (got ${typeof result})`,
  );
}

/** Encode a single byte as base58 — sufficient for memcmp on byte 0. */
function base58EncodeByte(b: number): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (b === 0) return '1';
  // For a single-byte value < 58, base58 is just the direct character.
  if (b < 58) return ALPHABET[b]!;
  // For 58..255 we need two chars.
  return ALPHABET[Math.floor(b / 58)]! + ALPHABET[b % 58]!;
}

async function main(): Promise<void> {
  const rpcUrl = process.env['RPC_URL'];
  if (!rpcUrl) {
    console.error('RPC_URL env var required. Usage: RPC_URL=https://... pnpm capture:metaplex');
    process.exit(2);
  }

  const endpoint: RpcEndpoint = {
    name: 'custom',
    url: rpcUrl,
    kind: 'http',
  };
  const pool = new RpcPool({
    endpoints: [endpoint],
    timeoutMs: 120_000,
    retry: { attempts: 2, backoffMs: 1000, jitter: 0.1 },
  });

  const programIdStr = METADATA_PROGRAM_ID.toBase58();

  const seen = new Map<string, RpcAccount>();
  for (const size of CANDIDATE_DATA_SIZES) {
    console.error(`Fetching Metaplex metadata (dataSize=${size})...`);
    try {
      const page = await fetchByDataSize(pool, programIdStr, size);
      console.error(`  got ${page.length}`);
      for (const a of page) {
        if (!seen.has(a.pubkey)) seen.set(a.pubkey, a);
      }
    } catch (err) {
      console.error(`  size=${size} failed (${(err as Error).message}); continuing`);
    }
  }

  const all = [...seen.values()];
  if (all.length === 0) {
    throw new Error(
      'No Metaplex accounts returned from any size filter. Most public endpoints reject getProgramAccounts on the Metadata program — use Helius/Triton/QuickNode with a paid tier.',
    );
  }

  const chosen = sample(all, SAMPLE_TARGET);

  console.error(`Decoding ${chosen.length} metadata accounts...`);
  let decodeFailures = 0;
  const accounts = chosen.map((r) => {
    const data = Buffer.from(r.account.data[0], 'base64');
    let decoded: unknown = null;
    let decodeError: string | null = null;
    try {
      decoded = decodeMetadata(data);
    } catch (e) {
      decodeError = (e as Error).message;
      decodeFailures += 1;
    }
    return {
      pubkey: r.pubkey,
      dataSize: data.length,
      dataBase64: r.account.data[0],
      decoded,
      decodeError,
    };
  });
  console.error(`  decode: ${accounts.length - decodeFailures} ok, ${decodeFailures} failed`);

  const output = {
    capturedAt: new Date().toISOString(),
    rpcEndpoint: sanitizeUrl(rpcUrl),
    count: accounts.length,
    accounts,
  };

  const json = JSON.stringify(output, jsonReplacer, 2);
  const gz = gzipSync(Buffer.from(json, 'utf8'));
  const outPath = 'tests/fixtures/metaplex-accounts.json.gz';
  await writeFile(outPath, gz);
  console.error(
    `Wrote ${outPath} (${gz.length.toLocaleString()} bytes gzipped, ${json.length.toLocaleString()} bytes raw)`,
  );
  console.error(
    `Captured ${accounts.length} metadata accounts at ${output.capturedAt}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
