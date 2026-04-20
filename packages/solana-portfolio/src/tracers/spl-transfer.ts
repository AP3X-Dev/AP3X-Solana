import type { PublicKey } from '@ap3x/solana-core';
import { SPL_TOKEN_PROGRAM_ID, decodeTransferInstruction } from '@ap3x/solana-spl';
import type { SwapTracer, ParsedTransaction, TraceResult } from '../swap-tracer.js';

/**
 * Plain SPL transfer tracer. Classifies inflows from a token transfer as
 * `transfer-in`. Cannot determine source wallet without an ATA→owner resolver;
 * verticals (e.g. pump.fun PRP-03) will register richer tracers that provide
 * cost-basis context.
 */
export class SplTransferSwapTracer implements SwapTracer {
  readonly programId = SPL_TOKEN_PROGRAM_ID;

  trace(tx: ParsedTransaction, _wallet: PublicKey, _mint: PublicKey): TraceResult | null {
    for (const ix of tx.instructions) {
      const decoded = decodeTransferInstruction(ix);
      if (decoded) return { kind: 'transfer-in' };
    }
    return null;
  }
}
