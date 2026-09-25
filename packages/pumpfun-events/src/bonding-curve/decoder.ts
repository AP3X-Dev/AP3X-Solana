import { PUMP_SCHEMA } from '../generated/idl-schema.js';
import { makeIdlDecoder } from '../program-decoder.js';
import { PUMPFUN_BONDING_CURVE_PROGRAM_ID } from '../program-ids.js';
import type { PumpFunBondingCurveEvent } from './event-types.js';

export const bondingCurveDecoder = makeIdlDecoder<PumpFunBondingCurveEvent>({
  programId: PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  schema: PUMP_SCHEMA,
  prefix: 'pumpfun',
  typed: {
    create: ['name', 'symbol', 'uri', 'mint', 'bondingCurve', 'user'],
    trade: [
      'mint', 'solAmount', 'tokenAmount', 'isBuy', 'user', 'timestamp',
      'virtualSolReserves', 'virtualTokenReserves', 'realSolReserves', 'realTokenReserves',
    ],
    complete: ['user', 'mint', 'bondingCurve', 'timestamp'],
    complete_pump_amm_migration: [
      'user', 'mint', 'mintAmount', 'solAmount', 'poolMigrationFee', 'bondingCurve', 'timestamp', 'pool',
    ],
    collect_creator_fee: ['timestamp', 'creator', 'creatorFee'],
    set_params: [
      'initialVirtualTokenReserves', 'initialVirtualSolReserves', 'initialRealTokenReserves',
      'finalRealSolReserves', 'tokenTotalSupply', 'feeBasisPoints',
    ],
  },
});
