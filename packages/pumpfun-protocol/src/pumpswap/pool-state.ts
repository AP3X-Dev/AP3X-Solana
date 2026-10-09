/**
 * Reading PumpSwap AMM state.
 *
 *   - {@link derivePumpSwapPoolPda} — the canonical pool a graduated pump.fun
 *     mint migrates into.
 *   - {@link decodePumpSwapPool} / {@link pumpSwapPoolState} — the `Pool`
 *     account plus live reserves. Reserves are not stored on the pool; they
 *     are the balances of its two token accounts.
 *   - {@link decodePumpSwapGlobalConfig} / {@link pumpSwapGlobalConfig} — fee
 *     rates and protocol fee recipients.
 *
 * Layouts come from the vendored IDL via `decodeIdlAccount`.
 */

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import {
  decodeIdlAccount,
  PUMP_AMM_SCHEMA,
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';
import type { RpcPool } from '@ap3x/solana-connectivity';
import { AccountLayoutError, fetchAccountData, fetchAccountDataBatch } from '../curve/state.js';

export const WSOL_MINT = /* @__PURE__ */ PublicKey.fromBase58('So11111111111111111111111111111111111111112');

const enc = new TextEncoder();

/** PumpSwap's singleton `GlobalConfig` account. */
export function derivePumpSwapGlobalConfigPda(): { address: PublicKey; bump: number } {
  return findProgramAddress([enc.encode('global_config')], PUMPFUN_PUMPSWAP_PROGRAM_ID);
}

/** `["pool-v2", base_mint]` — required trailing account on PumpSwap trades of pump.fun coins. */
export function derivePoolV2Pda(baseMint: PublicKey): { address: PublicKey; bump: number } {
  return findProgramAddress([enc.encode('pool-v2'), baseMint.toBuffer()], PUMPFUN_PUMPSWAP_PROGRAM_ID);
}

/** Pump.fun's per-mint authority that creates the migration pool. */
export function derivePoolAuthorityPda(mint: PublicKey): { address: PublicKey; bump: number } {
  return findProgramAddress([enc.encode('pool-authority'), mint.toBuffer()], PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

/**
 * The canonical PumpSwap pool for a graduated mint:
 * `["pool", index=0 (u16 LE), pool_authority(mint), mint, quoteMint]`.
 */
export function derivePumpSwapPoolPda(
  mint: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
): { address: PublicKey; bump: number } {
  const seeds = [
    enc.encode('pool'),
    new Uint8Array([0, 0]),
    derivePoolAuthorityPda(mint).address.toBuffer(),
    mint.toBuffer(),
    quoteMint.toBuffer(),
  ];
  return findProgramAddress(seeds, PUMPFUN_PUMPSWAP_PROGRAM_ID);
}

export interface PumpSwapPool {
  creatorFeeBps?: bigint;
  canEditCreatorFee?: boolean;
  isHolderReward?: boolean;
  protocolFees?: bigint;
  creatorFees?: bigint;
  accountLayoutVersion?: string;
  pool: PublicKey;
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
  /** Creator credited with creator fees; seeds the coin creator vault. */
  coinCreator: PublicKey;
  isCashbackCoin: boolean;
  /** Mayhem-mode pools must pay the reserved fee recipients. */
  isMayhemMode: boolean;
  /**
   * `Pool.virtual_quote_reserves` (i128): quote the program prices with on
   * top of the vault balance. 0 on pools that predate the field.
   */
  virtualQuoteReserves: bigint;
}

export interface PumpSwapPoolState extends PumpSwapPool {
  baseReserves: bigint;
  /**
   * Effective quote reserves the program prices with: the quote vault balance
   * plus `virtualQuoteReserves`. Checked against mainnet trade events on
   * 2026-10-03 (sells matched exactly; the raw vault balance did not).
   */
  quoteReserves: bigint;
  /** The quote vault's token balance alone. Not a pricing reserve. */
  quoteVaultBalance: bigint;
}

function decode(name: string, bytes: Uint8Array, required: string[], options: { layoutVersion?: string } = {}): Record<string, unknown> {
  let f: Record<string, unknown>;
  try {
    f = decodeIdlAccount(PUMP_AMM_SCHEMA, name, bytes, options);
  } catch (err) {
    throw new AccountLayoutError(name, bytes, (err as Error).message);
  }
  const missing = required.find((k) => !(k in f));
  if (missing) throw new AccountLayoutError(name, bytes, missing);
  return f;
}

function presentPoolFields(fields: Record<string, unknown>): Partial<PumpSwapPool> {
  const result: Record<string, unknown> = {};
  for (const name of ['creatorFeeBps', 'canEditCreatorFee', 'isHolderReward', 'protocolFees', 'creatorFees']) {
    if (name in fields) result[name] = fields[name];
  }
  return result;
}

export function decodePumpSwapPool(bytes: Uint8Array, pool: PublicKey, options: { layoutVersion?: string } = {}): PumpSwapPool {
  const f = decode('Pool', bytes, [
    'index', 'creator', 'baseMint', 'quoteMint', 'lpMint', 'poolBaseTokenAccount',
    'poolQuoteTokenAccount', 'lpSupply', 'coinCreator',
  ], options);
  return {
    ...(f['layoutVersion'] ? { accountLayoutVersion: String(f['layoutVersion']) } : {}),
    ...presentPoolFields(f),
    pool,
    index: f['index'] as number,
    creator: f['creator'] as PublicKey,
    baseMint: f['baseMint'] as PublicKey,
    quoteMint: f['quoteMint'] as PublicKey,
    lpMint: f['lpMint'] as PublicKey,
    poolBaseTokenAccount: f['poolBaseTokenAccount'] as PublicKey,
    poolQuoteTokenAccount: f['poolQuoteTokenAccount'] as PublicKey,
    lpSupply: f['lpSupply'] as bigint,
    coinCreator: f['coinCreator'] as PublicKey,
    isCashbackCoin: (f['isCashbackCoin'] as boolean | undefined) ?? false,
    isMayhemMode: (f['isMayhemMode'] as boolean | undefined) ?? false,
    virtualQuoteReserves: (f['virtualQuoteReserves'] as bigint | undefined) ?? 0n,
  };
}

/** SPL token account `amount` (u64 at offset 64 in both Token and Token-2022). */
function tokenAmount(bytes: Uint8Array, label: string): bigint {
  if (bytes.length < 72) throw new AccountLayoutError('token-account', bytes, label);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true);
}

export async function pumpSwapPoolState(rpcPool: RpcPool, pool: PublicKey): Promise<PumpSwapPoolState> {
  const decoded = decodePumpSwapPool(await fetchAccountData(rpcPool, pool, 'Pool'), pool);
  const [base, quote] = await fetchAccountDataBatch(rpcPool, [
    { address: decoded.poolBaseTokenAccount, label: 'pool base token account' },
    { address: decoded.poolQuoteTokenAccount, label: 'pool quote token account' },
  ]);
  const quoteVaultBalance = tokenAmount(quote!, 'quote');
  return {
    ...decoded,
    baseReserves: tokenAmount(base!, 'base'),
    quoteReserves: quoteVaultBalance + decoded.virtualQuoteReserves,
    quoteVaultBalance,
  };
}

export interface PumpSwapGlobalConfig {
  lpFeeBasisPoints: bigint;
  protocolFeeBasisPoints: bigint;
  coinCreatorFeeBasisPoints: bigint;
  /** Accepted protocol fee recipients (zero keys removed). */
  protocolFeeRecipients: PublicKey[];
  /** Protocol fee recipients for mayhem-mode pools (zero keys removed). */
  reservedFeeRecipients: PublicKey[];
  /** Accepted buyback fee recipients (zero keys removed). */
  buybackFeeRecipients: PublicKey[];
}

export function decodePumpSwapGlobalConfig(bytes: Uint8Array): PumpSwapGlobalConfig {
  const f = decode('GlobalConfig', bytes, ['lpFeeBasisPoints', 'protocolFeeBasisPoints', 'protocolFeeRecipients']);
  const zero = PublicKey.fromBytes(new Uint8Array(32));
  return {
    lpFeeBasisPoints: f['lpFeeBasisPoints'] as bigint,
    protocolFeeBasisPoints: f['protocolFeeBasisPoints'] as bigint,
    coinCreatorFeeBasisPoints: (f['coinCreatorFeeBasisPoints'] as bigint | undefined) ?? 0n,
    protocolFeeRecipients: (f['protocolFeeRecipients'] as PublicKey[]).filter((k) => !k.equals(zero)),
    reservedFeeRecipients: [
      ...(f['reservedFeeRecipient'] ? [f['reservedFeeRecipient'] as PublicKey] : []),
      ...((f['reservedFeeRecipients'] as PublicKey[] | undefined) ?? []),
    ].filter((k) => !k.equals(zero)),
    buybackFeeRecipients: ((f['buybackFeeRecipients'] as PublicKey[] | undefined) ?? []).filter((k) => !k.equals(zero)),
  };
}

/** The protocol fee recipient a trade on `pool` must pay (reserved for mayhem-mode pools). */
export function protocolFeeRecipientFor(
  config: PumpSwapGlobalConfig,
  pool: Pick<PumpSwapPool, 'isMayhemMode'>,
): PublicKey {
  const r = pool.isMayhemMode ? config.reservedFeeRecipients[0] : config.protocolFeeRecipients[0];
  if (!r) throw new Error('PumpSwap GlobalConfig has no protocol fee recipient for this pool');
  return r;
}

export async function pumpSwapGlobalConfig(rpcPool: RpcPool): Promise<PumpSwapGlobalConfig> {
  const bytes = await fetchAccountData(rpcPool, derivePumpSwapGlobalConfigPda().address, 'GlobalConfig');
  return decodePumpSwapGlobalConfig(bytes);
}
