import type { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';

const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
] as const;

interface GetTokenAccountsByOwnerResult {
  value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }[];
}

/**
 * The wallet's on-chain balance per mint (base58), summed across all its
 * token accounts under both the SPL Token and Token-2022 programs.
 */
export async function fetchTokenBalances(rpcPool: RpcPool, wallet: PublicKey): Promise<Map<string, bigint>> {
  const byMint = new Map<string, bigint>();
  for (const programId of TOKEN_PROGRAMS) {
    const res = (await rpcPool.call('getTokenAccountsByOwner', [
      wallet.toBase58(),
      { programId },
      { encoding: 'jsonParsed' },
    ])) as GetTokenAccountsByOwnerResult | null;
    for (const acc of res?.value ?? []) {
      const info = acc.account.data.parsed.info;
      byMint.set(info.mint, (byMint.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
    }
  }
  return byMint;
}
