import type { PublicKey } from '@ap3x/solana-core';

export interface ParsedTransaction {
  signature: string;
  slot: number;
  programIds: PublicKey[];
  meta: {
    preBalances: Map<string, bigint>;
    postBalances: Map<string, bigint>;
    preTokenBalances: Array<{ owner: PublicKey; mint: PublicKey; amount: bigint }>;
    postTokenBalances: Array<{ owner: PublicKey; mint: PublicKey; amount: bigint }>;
    feeLamports: bigint;
    logMessages: string[];
  };
  instructions: Array<{ programId: PublicKey; accounts: PublicKey[]; data: Uint8Array }>;
}

export type TraceResult =
  | { kind: 'swap'; solOut: bigint; tokensIn: bigint; meta?: Record<string, unknown> }
  | { kind: 'transfer-in'; sourceWallet?: PublicKey; meta?: Record<string, unknown> };

export interface SwapTracer {
  readonly programId: PublicKey;
  trace(tx: ParsedTransaction, wallet: PublicKey, mint: PublicKey): TraceResult | null;
}

export class SwapTracerRegistry {
  private readonly byProgram = new Map<string, SwapTracer[]>();

  register(tracer: SwapTracer): void {
    const key = tracer.programId.toBase58();
    const arr = this.byProgram.get(key) ?? [];
    arr.push(tracer);
    this.byProgram.set(key, arr);
  }

  tracersFor(programId: PublicKey): SwapTracer[] {
    return this.byProgram.get(programId.toBase58()) ?? [];
  }
}
