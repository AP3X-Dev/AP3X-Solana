/* ASSUMPTION: PumpSwap uses Anchor 8-byte discriminator + Borsh payload. Unverified without HELIUS_API_KEY. Surface UnknownEventDecode if the assumption is wrong. */

import type { ProgramDecoder, ProgramLogChunk, UnknownEventDecode } from '@ap3x/solana-events';
import { BorshReader } from '../borsh-helpers.js';
import { PUMPFUN_PUMPSWAP_PROGRAM_ID } from '../program-ids.js';
import {
  PUMPSWAP_EVENT_DISCRIMINATORS as DISC,
  matchDiscriminator,
  toHex,
} from './discriminator.js';
import type {
  PumpSwapEvent,
  PumpSwapSwapEvent,
  PumpSwapAddLiquidityEvent,
  PumpSwapRemoveLiquidityEvent,
  PumpSwapAdminEvent,
} from './event-types.js';

function unknown(reason: string): UnknownEventDecode {
  return {
    kind: 'unknown',
    programId: PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58(),
    reason,
  };
}

function decodeSwap(payload: Uint8Array): PumpSwapSwapEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const pool = r.readPublicKey();
    const user = r.readPublicKey();
    const inputMint = r.readPublicKey();
    const outputMint = r.readPublicKey();
    const inputAmount = r.readU64LE();
    const outputAmount = r.readU64LE();
    const poolBaseReserves = r.readU64LE();
    const poolQuoteReserves = r.readU64LE();
    const timestamp = r.readI64LE();
    return {
      kind: 'pumpfun.swap',
      pool,
      user,
      inputMint,
      outputMint,
      inputAmount,
      outputAmount,
      poolBaseReserves,
      poolQuoteReserves,
      timestamp,
    };
  } catch (err) {
    return unknown(`borsh-parse-error:swap:${(err as Error).message}`);
  }
}

function decodeAddLiquidity(
  payload: Uint8Array,
): PumpSwapAddLiquidityEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const pool = r.readPublicKey();
    const user = r.readPublicKey();
    const baseAmount = r.readU64LE();
    const quoteAmount = r.readU64LE();
    const lpTokens = r.readU64LE();
    const timestamp = r.readI64LE();
    return {
      kind: 'pumpfun.add_liquidity',
      pool,
      user,
      baseAmount,
      quoteAmount,
      lpTokens,
      timestamp,
    };
  } catch (err) {
    return unknown(`borsh-parse-error:add_liquidity:${(err as Error).message}`);
  }
}

function decodeRemoveLiquidity(
  payload: Uint8Array,
): PumpSwapRemoveLiquidityEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const pool = r.readPublicKey();
    const user = r.readPublicKey();
    const baseAmount = r.readU64LE();
    const quoteAmount = r.readU64LE();
    const lpTokens = r.readU64LE();
    const timestamp = r.readI64LE();
    return {
      kind: 'pumpfun.remove_liquidity',
      pool,
      user,
      baseAmount,
      quoteAmount,
      lpTokens,
      timestamp,
    };
  } catch (err) {
    return unknown(`borsh-parse-error:remove_liquidity:${(err as Error).message}`);
  }
}

function decodeAdmin(payload: Uint8Array): PumpSwapAdminEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const authority = r.readPublicKey();
    const newFeeBasisPoints = Number(r.readU64LE());
    const timestamp = r.readI64LE();
    return {
      kind: 'pumpfun.admin_set_params',
      authority,
      newFeeBasisPoints,
      timestamp,
    };
  } catch (err) {
    return unknown(`borsh-parse-error:admin_set_params:${(err as Error).message}`);
  }
}

export const pumpSwapDecoder: ProgramDecoder<PumpSwapEvent> = {
  programId: PUMPFUN_PUMPSWAP_PROGRAM_ID,
  decode(chunk: ProgramLogChunk): PumpSwapEvent | UnknownEventDecode {
    // PumpSwap is assumed to emit events as `Program data:` lines carrying
    // Anchor-encoded (8-byte discriminator + Borsh payload) blobs — the
    // same convention as the bonding curve program. The substrate's
    // parseLogs already base64-decodes these into chunk.dataPayloads.
    // If the assumption is wrong, every event surfaces UnknownEventDecode
    // (either no-data-payload or unknown-discriminator) and the nightly
    // diag gate catches it before any production consumer misbehaves.
    const data = chunk.dataPayloads[0];
    if (!data) return unknown('no-data-payload');
    if (data.length < 8) return unknown('truncated-data');

    if (matchDiscriminator(data, DISC.SwapEvent)) return decodeSwap(data.slice(8));
    if (matchDiscriminator(data, DISC.AddLiquidityEvent))
      return decodeAddLiquidity(data.slice(8));
    if (matchDiscriminator(data, DISC.RemoveLiquidityEvent))
      return decodeRemoveLiquidity(data.slice(8));
    if (matchDiscriminator(data, DISC.AdminSetParamsEvent))
      return decodeAdmin(data.slice(8));

    return unknown(`unknown-discriminator:${toHex(data.slice(0, 8))}`);
  },
};
