import type { RpcPool } from '@ap3x/solana-connectivity';
import { base58 } from '@ap3x/solana-core';
import { HealthTracker, type Submitter, type SubmitPayload, type SubmissionAck, type SubmitterHealth } from '../submitter.js';

export interface RpcSubmitterOpts {
  rpcPool: RpcPool;
  /** How long a failure marks this submitter unhealthy (default 30s). */
  unhealthyCooldownMs?: number;
}

export class RpcSubmitter implements Submitter {
  readonly name = 'rpc';
  readonly kind = 'rpc' as const;
  readonly #rpcPool: RpcPool;
  readonly #health: HealthTracker;

  constructor(opts: RpcSubmitterOpts) {
    this.#rpcPool = opts.rpcPool;
    this.#health = new HealthTracker(opts.unhealthyCooldownMs);
  }

  async submit(payload: SubmitPayload): Promise<SubmissionAck> {
    if (payload.kind !== 'tx') {
      throw new Error('RpcSubmitter only handles single-tx payloads; use JitoSubmitter for bundles');
    }

    return this.#health.track(async () => {
      // Pin the best endpoint for write affinity (lowest EWMA, non-unhealthy).
      // `pinForWrite()` warms the pool's selection heuristic and surfaces
      // config errors (circuit_open) early.
      this.#rpcPool.pinForWrite();

      const sig = await this.#rpcPool.call('sendTransaction', [
        base58.encode(payload.signedTx),
        { skipPreflight: true, maxRetries: 0, encoding: 'base58' },
      ]);
      return { kind: 'tx' as const, signature: sig as string, submitterUsed: this.name };
    });
  }

  health(): SubmitterHealth {
    return this.#health.health();
  }
}
