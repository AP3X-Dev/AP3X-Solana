/**
 * Reading pump.fun bonding-curve program state.
 *
 *   - {@link deriveBondingCurvePda} — PDA derivation from a mint.
 *   - {@link decodeCurveState} / {@link curveState} — the per-mint `BondingCurve` account.
 *   - {@link decodeGlobalState} / {@link globalState} — the singleton `Global` account
 *     (fee recipients and fee rates the trade builders need).
 *
 * Layouts come from the vendored IDL via `decodeIdlAccount`.
 */

import { PublicKey } from '@ap3x/solana-core';
import { findProgramAddress } from '@ap3x/solana-tx';
import { decodeIdlAccount, PUMP_SCHEMA, PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '@ap3x/pumpfun-events';
import type { RpcPool } from '@ap3x/solana-connectivity';

/**
 * Decoded `BondingCurve` account. pump.fun now supports non-SOL quote mints;
 * the `*Sol*` fields hold the quote-side reserves (lamports for SOL curves).
 */
export interface CurveState {
  mint: PublicKey;
  bondingCurve: PublicKey;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  /** `true` once the curve has sold out; trading moves to PumpSwap after migration. */
  complete: boolean;
  /** Creator credited with creator fees; seeds the `creator_vault` account. */
  creator: PublicKey;
  /** Quote mint, when the account carries it (absent on older curves = SOL). */
  quoteMint?: PublicKey;
  /** Cashback coins route the creator fee to traders; sells pass an extra account. */
  isCashbackCoin: boolean;
  /** Mayhem-mode coins must pay the reserved fee recipients (see {@link feeRecipientFor}). */
  isMayhemMode: boolean;
  creatorFeeBps?: bigint;
  canEditCreatorFee?: boolean;
  isHolderReward?: boolean;
  creatorFee?: bigint;
  protocolFees?: bigint;
  depth?: number;
  initialVirtualQuoteReserves?: bigint;
  postCompleteBaseOut?: bigint;
  postCompleteQuoteIn?: bigint;
  accountLayoutVersion?: string;
}

export class AccountLayoutError extends Error {
  constructor(
    public readonly expected: string,
    public readonly observed: Uint8Array,
    public readonly field?: string,
  ) {
    super(`account layout mismatch: expected ${expected}${field ? ` (field: ${field})` : ''}`);
    this.name = 'AccountLayoutError';
  }
}

export function deriveBondingCurvePda(mint: PublicKey): { address: PublicKey; bump: number } {
  const seeds = [new TextEncoder().encode('bonding-curve'), mint.toBuffer()];
  return findProgramAddress(seeds, PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

/** `["bonding-curve-v2", mint]` — required trailing account on bonding-curve trades. */
export function deriveBondingCurveV2Pda(mint: PublicKey): { address: PublicKey; bump: number } {
  return findProgramAddress([new TextEncoder().encode('bonding-curve-v2'), mint.toBuffer()], PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

export function deriveGlobalPda(): { address: PublicKey; bump: number } {
  return findProgramAddress([new TextEncoder().encode('global')], PUMPFUN_BONDING_CURVE_PROGRAM_ID);
}

function decodeAccount(name: string, bytes: Uint8Array, required: string[], options: { layoutVersion?: string } = {}): Record<string, unknown> {
  let fields: Record<string, unknown>;
  try {
    fields = decodeIdlAccount(PUMP_SCHEMA, name, bytes, options);
  } catch (err) {
    throw new AccountLayoutError(name, bytes, (err as Error).message);
  }
  const missing = required.find((f) => !(f in fields));
  if (missing) throw new AccountLayoutError(name, bytes, missing);
  return fields;
}

function presentFields(fields: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of names) if (name in fields) result[name] = fields[name];
  return result;
}

export function decodeCurveState(bytes: Uint8Array, mint: PublicKey, options: { layoutVersion?: string } = {}): CurveState {
  const f = decodeAccount('BondingCurve', bytes, [
    'virtualTokenReserves', 'virtualQuoteReserves', 'realTokenReserves', 'realQuoteReserves',
    'tokenTotalSupply', 'complete', 'creator',
  ], options);
  return {
    ...(f['layoutVersion'] ? { accountLayoutVersion: String(f['layoutVersion']) } : {}),
    ...presentFields(f, ['creatorFeeBps', 'canEditCreatorFee', 'isHolderReward', 'creatorFee',
      'protocolFees', 'depth', 'initialVirtualQuoteReserves', 'postCompleteBaseOut', 'postCompleteQuoteIn']) as Partial<CurveState>,
    mint,
    bondingCurve: deriveBondingCurvePda(mint).address,
    virtualSolReserves: f['virtualQuoteReserves'] as bigint,
    virtualTokenReserves: f['virtualTokenReserves'] as bigint,
    realSolReserves: f['realQuoteReserves'] as bigint,
    realTokenReserves: f['realTokenReserves'] as bigint,
    tokenTotalSupply: f['tokenTotalSupply'] as bigint,
    complete: f['complete'] as boolean,
    creator: f['creator'] as PublicKey,
    isCashbackCoin: (f['isCashbackCoin'] as boolean | undefined) ?? false,
    isMayhemMode: (f['isMayhemMode'] as boolean | undefined) ?? false,
    ...(f['quoteMint'] ? { quoteMint: f['quoteMint'] as PublicKey } : {}),
  };
}

/** Decoded `Global` account — only the fields trading needs. */
export interface GlobalState {
  maxCurveDepth?: number;
  /** Primary fee recipient. */
  feeRecipient: PublicKey;
  /** Additional fee recipients the program accepts (zero keys removed). */
  feeRecipients: PublicKey[];
  /** Fee recipients for mayhem-mode coins (zero keys removed). */
  reservedFeeRecipients: PublicKey[];
  /** Buyback fee recipients (zero keys removed); trades must pass one. */
  buybackFeeRecipients: PublicKey[];
  feeBasisPoints: bigint;
  creatorFeeBasisPoints: bigint;
}

export function decodeGlobalState(bytes: Uint8Array, options: { layoutVersion?: string } = {}): GlobalState {
  const f = decodeAccount('Global', bytes, ['feeRecipient', 'feeBasisPoints'], options);
  const zero = PublicKey.fromBytes(new Uint8Array(32));
  return {
    ...presentFields(f, ['maxCurveDepth']) as Partial<GlobalState>,
    feeRecipient: f['feeRecipient'] as PublicKey,
    feeRecipients: ((f['feeRecipients'] as PublicKey[] | undefined) ?? []).filter((k) => !k.equals(zero)),
    reservedFeeRecipients: [
      ...(f['reservedFeeRecipient'] ? [f['reservedFeeRecipient'] as PublicKey] : []),
      ...((f['reservedFeeRecipients'] as PublicKey[] | undefined) ?? []),
    ].filter((k) => !k.equals(zero)),
    buybackFeeRecipients: ((f['buybackFeeRecipients'] as PublicKey[] | undefined) ?? []).filter((k) => !k.equals(zero)),
    feeBasisPoints: f['feeBasisPoints'] as bigint,
    creatorFeeBasisPoints: (f['creatorFeeBasisPoints'] as bigint | undefined) ?? 0n,
  };
}

/**
 * The fee recipient a trade on `curve` must pay: a reserved recipient for
 * mayhem-mode coins, the primary recipient otherwise.
 */
export function feeRecipientFor(global: GlobalState, curve: Pick<CurveState, 'isMayhemMode'>): PublicKey {
  const r = curve.isMayhemMode ? global.reservedFeeRecipients[0] : global.feeRecipient;
  if (!r) throw new Error('pump.fun Global has no reserved fee recipient for a mayhem-mode coin');
  return r;
}

/**
 * One account's bytes at `confirmed`: the RPC default is `finalized`, ~13 s
 * behind, which makes quotes stale and a fresh curve or pool "not found".
 */
export async function fetchAccountData(rpcPool: RpcPool, address: PublicKey, label: string): Promise<Uint8Array> {
  const response = (await rpcPool.call('getAccountInfo', [
    address.toBase58(),
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value: { data: [string, string] } | null };
  if (!response?.value?.data) {
    throw new AccountLayoutError(label, new Uint8Array(), 'account not found');
  }
  return Uint8Array.from(Buffer.from(response.value.data[0], 'base64'));
}

/** Fresh ordered account reads in one response; no cache or fallback requests. */
export async function fetchAccountDataBatch(rpcPool: RpcPool, accounts: readonly { address: PublicKey; label: string }[],
  dataSlice?: { offset: number; length: number }): Promise<Uint8Array[]> {
  const requested = accounts.map(account => ({ ...account }));
  if (requested.length > 100 || requested.some(a => !a.label.trim())) throw new Error('account batch bounds');
  if (dataSlice && (!Number.isSafeInteger(dataSlice.offset) || !Number.isSafeInteger(dataSlice.length)
    || dataSlice.offset < 0 || dataSlice.length < 0)) throw new Error('account batch slice');
  if (!requested.length) return [];
  const response = await rpcPool.call('getMultipleAccounts', [requested.map(a => a.address.toBase58()),
    { encoding: 'base64', commitment: 'confirmed', ...(dataSlice ? { dataSlice: { ...dataSlice } } : {}) }]) as {
      value?: Array<{ data?: unknown } | null> };
  if (!Array.isArray(response?.value) || response.value.length !== requested.length)
    throw new AccountLayoutError('account batch', new Uint8Array(), 'response length mismatch');
  return response.value.map((account, index) => {
    const label = requested[index]!.label;
    if (!account) throw new AccountLayoutError(label, new Uint8Array(), 'account not found');
    const data = account.data;
    if (!Array.isArray(data) || data.length !== 2 || typeof data[0] !== 'string' || data[1] !== 'base64')
      throw new AccountLayoutError(label, new Uint8Array(), 'account encoding');
    const bytes = Buffer.from(data[0], 'base64');
    if (bytes.toString('base64') !== data[0]) throw new AccountLayoutError(label, new Uint8Array(), 'account encoding');
    return Uint8Array.from(bytes);
  });
}

export async function curveState(rpcPool: RpcPool, mint: PublicKey): Promise<CurveState> {
  const bytes = await fetchAccountData(rpcPool, deriveBondingCurvePda(mint).address, 'BondingCurve');
  return decodeCurveState(bytes, mint);
}

export async function globalState(rpcPool: RpcPool): Promise<GlobalState> {
  return decodeGlobalState(await fetchAccountData(rpcPool, deriveGlobalPda().address, 'Global'));
}
