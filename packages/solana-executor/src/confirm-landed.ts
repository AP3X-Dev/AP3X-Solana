import type { RpcPool } from '@ap3x/solana-connectivity';

// ---------------------------------------------------------------------------
// RPC response shapes
// ---------------------------------------------------------------------------

interface SignatureStatus {
  slot: number;
  confirmationStatus: string;
  err: unknown;
}

interface SignatureStatusesResponse {
  value: Array<SignatureStatus | null>;
}

interface TransactionResponse {
  meta?: {
    logMessages?: string[];
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConfirmLandedOpts {
  rpcPool: RpcPool;
  signature: string;
  deadline: number;
  pollIntervalMs?: number;
}

export type ConfirmResult =
  | { kind: 'landed'; slot: number; landedAt: number }
  | { kind: 'reverted'; slot: number; logs: string[]; error: string }
  | { kind: 'timeout' };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function confirmLanded(opts: ConfirmLandedOpts): Promise<ConfirmResult> {
  const interval = opts.pollIntervalMs ?? 250;

  while (Date.now() < opts.deadline) {
    const result = opts.rpcPool.call('getSignatureStatuses', [
      [opts.signature],
      { searchTransactionHistory: true },
    ]) as Promise<SignatureStatusesResponse>;

    const response = await result;
    const status = response?.value?.[0] ?? null;

    if (status !== null) {
      if (status.err) {
        const tx = (await opts.rpcPool.call('getTransaction', [
          opts.signature,
          { maxSupportedTransactionVersion: 0 },
        ])) as TransactionResponse | null;

        return {
          kind: 'reverted',
          slot: status.slot,
          logs: tx?.meta?.logMessages ?? [],
          error: JSON.stringify(status.err),
        };
      }

      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return { kind: 'landed', slot: status.slot, landedAt: Date.now() };
      }
    }

    await new Promise<void>((res) => setTimeout(res, interval));
  }

  return { kind: 'timeout' };
}
