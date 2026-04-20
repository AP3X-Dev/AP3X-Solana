/**
 * `metadata` — fetch + decode the pump.fun-surface Metaplex metadata for a
 * mint, and resolve its off-chain JSON in one call.
 *
 * Composition:
 *   1. `getMetadataPda(mint)`                         — pure PDA derivation
 *   2. `rpcPool.call('getAccountInfo', …)`            — one RPC round-trip
 *   3. `decodeMetadata(bytes)`                        — pure Borsh decode
 *   4. `resolver.resolve(onChain.uri)`                — memory/file/network cache
 *
 * Every step lives elsewhere (the substrate's `@ap3x/solana-metaplex`); this
 * module only wires them together for the pump.fun read surface so the
 * vertical doesn't have to re-derive the PDA or re-plumb the HTTP client.
 *
 * Ecosystem-dep policy: no runtime dependency on web3.js, spl-token, or
 * `@metaplex-foundation/*` — all Metaplex decoding lives in our hand-rolled
 * `@ap3x/solana-metaplex` package.
 *
 * Error policy:
 *   - Missing metadata account → throw `Error` with `mint` tag. Pump.fun
 *     writes the metadata account at mint time, so absence is unexpected
 *     and we do not silently fall back to a stub.
 *   - Malformed on-chain bytes → propagate whatever `decodeMetadata` throws
 *     (it's loud by design on header mismatches).
 *   - Off-chain JSON problems (404, timeout, invalid JSON, missing name)
 *     → do NOT throw. The resolver surfaces those as `parseErrors` inside
 *     the returned `ResolvedMetadata`, matching its documented contract.
 *     Callers inspecting `offChain.parseErrors` can decide how strict to be.
 */

import type { PublicKey } from '@ap3x/solana-core';
import type { RpcPool } from '@ap3x/solana-connectivity';
import {
  decodeMetadata,
  getMetadataPda,
  MetadataResolver,
} from '@ap3x/solana-metaplex';
import type {
  MetadataAccount,
  ResolvedMetadata,
} from '@ap3x/solana-metaplex';

/**
 * Combined on-chain + off-chain metadata for a pump.fun mint.
 *
 *   - `onChain` carries the fully-decoded Metaplex account (name, symbol,
 *     uri, creators, verified flags, ...).
 *   - `offChain` carries the resolver's result for the URI stored on-chain.
 *     Always present; read `offChain.parseErrors` to find out if the JSON
 *     round-tripped cleanly.
 */
export interface PumpFunMetadata {
  onChain: MetadataAccount;
  offChain: ResolvedMetadata;
}

/**
 * One-shot fetch: derive the Metaplex metadata PDA for `mint`, pull the
 * account via `getAccountInfo`, decode it, and resolve the stored URI.
 *
 * Stateless apart from whatever cache layers `resolver` carries internally.
 */
export async function metadata(
  rpcPool: RpcPool,
  resolver: MetadataResolver,
  mint: PublicKey,
): Promise<PumpFunMetadata> {
  const { address: pda } = getMetadataPda(mint);
  const response = (await rpcPool.call('getAccountInfo', [
    pda.toBase58(),
    { encoding: 'base64' },
  ])) as { value: { data: [string, string] } | null };

  if (!response?.value?.data) {
    throw new Error(`metadata account not found for mint ${mint.toBase58()}`);
  }

  const [base64Data] = response.value.data;
  const bytes = Uint8Array.from(Buffer.from(base64Data, 'base64'));
  const onChain = decodeMetadata(bytes);
  const offChain = await resolver.resolve(onChain.uri);
  return { onChain, offChain };
}
