import type { TypedSolanaEvent } from '../../types.js';

// ---------------------------------------------------------------------------
// Helius Enhanced Webhook envelope (the fields the driver actually reads)
// ---------------------------------------------------------------------------

/**
 * Slice of Helius's "enhanced transaction" payload that this driver reads.
 * The wire shape carries many more fields (description, accountData,
 * instructions, events.nft, etc.) — they're ignored here on purpose: the
 * driver normalises into a substrate-shape, not into a Helius-specific shape,
 * so consumers don't bind to fields that change when Helius's schema does.
 */
export interface HeliusEnhancedTx {
  signature: string;
  /** Slot. Present on real webhooks; defaults to 0 when omitted by tests / older payloads. */
  slot?: number;
  /** Unix seconds. Optional. */
  timestamp?: number;
  /** Helius classification. SWAP, TRANSFER, TOKEN_MINT, UNKNOWN, ... */
  type?: string;
  /** Free-form venue label: "JUPITER", "PUMP_FUN", "RAYDIUM", "SYSTEM_PROGRAM", ... */
  source?: string;
  feePayer?: string;
  /** `null` when the tx landed successfully. Truthy object on failure. */
  transactionError?: unknown;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
}

export interface HeliusTokenTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  mint: string;
  /** UI-decimal-adjusted (Helius normalizes this for us). */
  tokenAmount: number;
  tokenStandard?: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  /** Lamports (1e9 per SOL). */
  amount: number;
}

// ---------------------------------------------------------------------------
// Venue program-id resolution
// ---------------------------------------------------------------------------

/** Pump.fun bonding curve program. */
export const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** Jupiter aggregator V6. */
export const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Raydium AMM V4. */
export const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
/**
 * Sentinel program id used when the venue can't be inferred from Helius's
 * `source` field. Substrate consumers treat this as "unknown program" and
 * filter or fan out to a fallback decoder.
 */
export const UNKNOWN_PROGRAM = '11111111111111111111111111111111';

/**
 * Map a Helius `source` label to the on-chain program id the swap settled
 * through. Helius's labels are free-form strings, so the match is case-
 * insensitive substring rather than exact — `"PUMP_FUN"` and
 * `"PUMP_AMM_V2"` both map to the pump.fun program for our purposes.
 */
export function venueProgramId(tx: HeliusEnhancedTx): string {
  const s = (tx.source ?? '').toUpperCase();
  if (s.includes('PUMP'))    return PUMPFUN_PROGRAM;
  if (s.includes('JUPITER')) return JUPITER_V6_PROGRAM;
  if (s.includes('RAYDIUM')) return RAYDIUM_AMM_V4_PROGRAM;
  return UNKNOWN_PROGRAM;
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

/**
 * Normalised swap/transfer payload. The driver passes this through as
 * `data` on a `DecodedEvent` so consumers downstream of the bus can classify
 * (buy / sell / route) without re-parsing Helius's wire shape.
 *
 * `variant` separates the three classifications the driver emits:
 * - `helius-swap`: tx.type === SWAP
 * - `helius-token-mint`: tx.type === TOKEN_MINT (pump.fun graduations etc)
 * - `helius-transfer`: tx.type === TRANSFER (no venue)
 */
export interface HeliusDecodedData {
  variant: 'helius-swap' | 'helius-token-mint' | 'helius-transfer';
  source: string | null;
  feePayer: string | null;
  timestamp: number | null;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
}

/**
 * Convert one Helius enhanced-tx into one or more {@link TypedSolanaEvent}s.
 * Returns an array because the contract permits future per-instruction fan-out;
 * today every Helius tx maps to exactly one substrate event.
 *
 * Rules:
 *  - `transactionError` truthy → `UnknownEventDecode { reason: 'transaction failed' }`.
 *    Drops would violate the substrate "never silently drop" rule; we emit
 *    so observability sees the failure.
 *  - `type` SWAP / TOKEN_MINT / TRANSFER → `DecodedEvent` with the
 *    corresponding `variant`. Missing transfers are normalised to `[]` so
 *    consumers never see `undefined`.
 *  - any other / missing `type` → `UnknownEventDecode` with reason
 *    `helius type=<...> not classifiable` so consumers can iterate on the
 *    classifier without touching driver code.
 */
export function normalizeHeliusTx(tx: HeliusEnhancedTx): TypedSolanaEvent[] {
  const slot = Number.isFinite(tx.slot) ? Number(tx.slot) : 0;
  const signature = tx.signature;

  if (tx.transactionError != null) {
    return [
      {
        kind: 'unknown',
        slot,
        signature,
        programId: UNKNOWN_PROGRAM,
        reason: 'transaction failed',
      },
    ];
  }

  const type = (tx.type ?? '').toUpperCase();
  const variant: HeliusDecodedData['variant'] | null =
    type === 'SWAP'        ? 'helius-swap' :
    type === 'TOKEN_MINT'  ? 'helius-token-mint' :
    type === 'TRANSFER'    ? 'helius-transfer' :
    null;

  if (!variant) {
    return [
      {
        kind: 'unknown',
        slot,
        signature,
        programId: UNKNOWN_PROGRAM,
        reason: `helius type=${tx.type ?? 'missing'} not classifiable`,
      },
    ];
  }

  // Transfers have no venue.
  const programId = variant === 'helius-transfer' ? UNKNOWN_PROGRAM : venueProgramId(tx);

  const data: HeliusDecodedData = {
    variant,
    source: tx.source ?? null,
    feePayer: tx.feePayer ?? null,
    timestamp: typeof tx.timestamp === 'number' ? tx.timestamp : null,
    tokenTransfers: normaliseTokenTransfers(tx.tokenTransfers),
    nativeTransfers: normaliseNativeTransfers(tx.nativeTransfers),
  };

  return [
    {
      kind: 'decoded',
      slot,
      signature,
      programId,
      data,
    },
  ];
}

function normaliseTokenTransfers(raw: HeliusTokenTransfer[] | undefined): HeliusTokenTransfer[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const out: HeliusTokenTransfer = {
      fromUserAccount: t.fromUserAccount ?? null,
      toUserAccount: t.toUserAccount ?? null,
      mint: t.mint ?? '',
      tokenAmount: numericOrZero(t.tokenAmount),
    };
    if (t.tokenStandard) out.tokenStandard = t.tokenStandard;
    return out;
  });
}

function normaliseNativeTransfers(raw: HeliusNativeTransfer[] | undefined): HeliusNativeTransfer[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => ({
    fromUserAccount: t.fromUserAccount ?? null,
    toUserAccount: t.toUserAccount ?? null,
    amount: numericOrZero(t.amount),
  }));
}

function numericOrZero(x: unknown): number {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string') {
    const parsed = Number(x);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
