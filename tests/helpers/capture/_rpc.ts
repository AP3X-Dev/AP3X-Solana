/* eslint-disable */
/**
 * Minimal JSON-RPC client for the capture scripts. Public endpoints rate-limit
 * hard, so this backs off on HTTP 429 instead of tripping a circuit breaker
 * (RpcPool's breaker stays open between one-off calls with no health probe).
 *
 * RPC_URL overrides the endpoint; otherwise HELIUS_API_KEY selects Helius and
 * the public mainnet endpoint is the fallback.
 */

export function rpcUrl(): string {
  const apiKey = process.env['HELIUS_API_KEY'];
  return (
    process.env['RPC_URL'] ??
    (apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : 'https://api.mainnet-beta.solana.com')
  );
}

export async function rpc<T = unknown>(method: string, params: unknown[], url = rpcUrl()): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 30) {
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** Math.min(attempt, 5)));
      continue;
    }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

/** Walk an address's history newest-first, `pageSize` signatures at a time. */
export async function* signatures(address: string, max: number, pageSize = 100): AsyncGenerator<SignatureInfo> {
  let before: string | undefined;
  let seen = 0;
  while (seen < max) {
    const page = await rpc<SignatureInfo[]>('getSignaturesForAddress', [
      address,
      { limit: pageSize, ...(before ? { before } : {}) },
    ]);
    if (page.length === 0) return;
    before = page[page.length - 1]!.signature;
    for (const s of page) {
      if (seen++ >= max) return;
      yield s;
    }
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 → bytes (instruction data in `json`-encoded transactions). */
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
