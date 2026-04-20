import type { ProgramDecoder, ProgramLogChunk, UnknownEventDecode } from '@ap3x/solana-events';
import { BorshReader } from '../borsh-helpers.js';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '../program-ids.js';
import {
  BONDING_CURVE_EVENT_DISCRIMINATORS as DISC,
  matchDiscriminator,
  toHex,
} from './discriminator.js';
import type {
  PumpFunBondingCurveEvent,
  PumpFunCreateEvent,
  PumpFunTradeEvent,
  PumpFunCompleteEvent,
  PumpFunSetParamsEvent,
  PumpFunCreatorFeeEvent,
  PumpFunMigrateEvent,
} from './event-types.js';

function unknown(reason: string): UnknownEventDecode {
  return {
    kind: 'unknown',
    programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58(),
    reason,
  };
}

function decodeCreate(payload: Uint8Array): PumpFunCreateEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const name = r.readString();
    const symbol = r.readString();
    const uri = r.readString();
    const mint = r.readPublicKey();
    const bondingCurve = r.readPublicKey();
    const creator = r.readPublicKey();
    const timestamp = r.readI64LE();
    const initialVirtualTokenReserves = r.readU64LE();
    const initialVirtualSolReserves = r.readU64LE();
    return {
      kind: 'pumpfun.create',
      mint,
      name,
      symbol,
      uri,
      creator,
      bondingCurve,
      initialVirtualSolReserves,
      initialVirtualTokenReserves,
      timestamp,
    };
  } catch (err) {
    return unknown(`borsh-parse-error:create:${(err as Error).message}`);
  }
}

function decodeTrade(payload: Uint8Array): PumpFunTradeEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const mint = r.readPublicKey();
    const solAmount = r.readU64LE();
    const tokenAmount = r.readU64LE();
    const isBuy = r.readBool();
    const user = r.readPublicKey();
    const timestamp = r.readI64LE();
    const virtualSolReserves = r.readU64LE();
    const virtualTokenReserves = r.readU64LE();
    const realSolReserves = r.readU64LE();
    const realTokenReserves = r.readU64LE();
    return {
      kind: 'pumpfun.trade',
      mint,
      solAmount,
      tokenAmount,
      isBuy,
      user,
      timestamp,
      virtualSolReserves,
      virtualTokenReserves,
      realSolReserves,
      realTokenReserves,
    };
  } catch (err) {
    return unknown(`borsh-parse-error:trade:${(err as Error).message}`);
  }
}

function decodeComplete(payload: Uint8Array): PumpFunCompleteEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const user = r.readPublicKey();
    const mint = r.readPublicKey();
    const bondingCurve = r.readPublicKey();
    const timestamp = r.readI64LE();
    return { kind: 'pumpfun.complete', user, mint, bondingCurve, timestamp };
  } catch (err) {
    return unknown(`borsh-parse-error:complete:${(err as Error).message}`);
  }
}

function decodeSetParams(payload: Uint8Array): PumpFunSetParamsEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const feeRecipient = r.readPublicKey();
    const initialVirtualTokenReserves = r.readU64LE();
    const initialVirtualSolReserves = r.readU64LE();
    const initialRealTokenReserves = r.readU64LE();
    const tokenTotalSupply = r.readU64LE();
    const feeBasisPoints = Number(r.readU64LE());
    return {
      kind: 'pumpfun.set_params',
      feeRecipient,
      initialVirtualTokenReserves,
      initialVirtualSolReserves,
      initialRealTokenReserves,
      tokenTotalSupply,
      feeBasisPoints,
    };
  } catch (err) {
    return unknown(`borsh-parse-error:set_params:${(err as Error).message}`);
  }
}

function decodeCreatorFee(payload: Uint8Array): PumpFunCreatorFeeEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const mint = r.readPublicKey();
    const creator = r.readPublicKey();
    const solAmount = r.readU64LE();
    const timestamp = r.readI64LE();
    return { kind: 'pumpfun.creator_fee', mint, creator, solAmount, timestamp };
  } catch (err) {
    return unknown(`borsh-parse-error:creator_fee:${(err as Error).message}`);
  }
}

function decodeMigrate(payload: Uint8Array): PumpFunMigrateEvent | UnknownEventDecode {
  try {
    const r = new BorshReader(payload);
    const mint = r.readPublicKey();
    const bondingCurve = r.readPublicKey();
    const pool = r.readPublicKey();
    const timestamp = r.readI64LE();
    return { kind: 'pumpfun.migrate', mint, bondingCurve, pool, timestamp };
  } catch (err) {
    return unknown(`borsh-parse-error:migrate:${(err as Error).message}`);
  }
}

export const bondingCurveDecoder: ProgramDecoder<PumpFunBondingCurveEvent> = {
  programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  decode(chunk: ProgramLogChunk): PumpFunBondingCurveEvent | UnknownEventDecode {
    // Pump.fun emits events as `Program data:` lines carrying Anchor-encoded
    // (discriminator + borsh payload) blobs. The substrate's parseLogs
    // already base64-decodes these into chunk.dataPayloads.
    const data = chunk.dataPayloads[0];
    if (!data) return unknown('no-data-payload');
    if (data.length < 8) return unknown('truncated-data');

    if (matchDiscriminator(data, DISC.CreateEvent)) return decodeCreate(data.slice(8));
    if (matchDiscriminator(data, DISC.TradeEvent)) return decodeTrade(data.slice(8));
    if (matchDiscriminator(data, DISC.CompleteEvent)) return decodeComplete(data.slice(8));
    if (matchDiscriminator(data, DISC.SetParamsEvent)) return decodeSetParams(data.slice(8));
    if (matchDiscriminator(data, DISC.CreatorFeeEvent)) return decodeCreatorFee(data.slice(8));
    if (matchDiscriminator(data, DISC.MigrateEvent)) return decodeMigrate(data.slice(8));

    return unknown(`unknown-discriminator:${toHex(data.slice(0, 8))}`);
  },
};
