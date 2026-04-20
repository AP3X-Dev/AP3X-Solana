export type SubmitPayload =
  | { kind: 'tx'; signedTx: Uint8Array }
  | { kind: 'bundle'; signedTxs: Uint8Array[]; tipLamports: bigint };

export interface SubmissionAck {
  kind: 'tx' | 'bundle';
  signature?: string;     // for tx submits
  bundleId?: string;      // for bundle submits
  submitterUsed: string;
}

export interface SubmitterHealth {
  state: 'healthy' | 'degraded' | 'unhealthy';
  reason?: string;
  lastOkAt?: number;
}

export interface Submitter {
  readonly name: string;
  readonly kind: 'rpc' | 'jito-http' | 'jito-grpc' | 'custom';
  submit(payload: SubmitPayload): Promise<SubmissionAck>;
  health(): SubmitterHealth;
}
