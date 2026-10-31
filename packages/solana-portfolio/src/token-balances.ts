import { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';

const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
] as const;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function balanceInfo(value: unknown): { mint: string; amount: bigint } {
  const account = record(record(value)?.['account']);
  const data = record(account?.['data']);
  const info = record(record(data?.['parsed'])?.['info']);
  const mint = info?.['mint'];
  const amount = record(info?.['tokenAmount'])?.['amount'];
  if (typeof mint !== 'string' || typeof amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amount)) {
    throw new Error('Invalid token balance account evidence: expected a mint and exact unsigned raw amount');
  }
  try { PublicKey.fromBase58(mint); } catch {
    throw new Error('Invalid token balance mint');
  }
  const raw = BigInt(amount);
  if (raw > 18_446_744_073_709_551_615n) throw new Error('Invalid token balance amount: exceeds u64');
  return { mint, amount: raw };
}

/**
 * The wallet's on-chain balance per mint (base58), summed across all its
 * token accounts under both the SPL Token and Token-2022 programs.
 */
export async function fetchTokenBalances(rpcPool: RpcPool, wallet: PublicKey): Promise<Map<string, bigint>> {
  const byMint = new Map<string, bigint>();
  for (const programId of TOKEN_PROGRAMS) {
    const res = await rpcPool.call('getTokenAccountsByOwner', [
      wallet.toBase58(),
      { programId },
      { encoding: 'jsonParsed' },
    ]);
    const accounts = record(res)?.['value'];
    if (!Array.isArray(accounts)) {
      throw new Error(`Missing or malformed token balance response for ${programId}`);
    }
    for (const acc of accounts) {
      const info = balanceInfo(acc);
      byMint.set(info.mint, (byMint.get(info.mint) ?? 0n) + info.amount);
    }
  }
  return byMint;
}
