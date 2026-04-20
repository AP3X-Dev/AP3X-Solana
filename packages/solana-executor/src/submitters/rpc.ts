import type { RpcPool } from '@ap3x/solana-connectivity';
import { base58 } from '@ap3x/solana-core';
import type { Submitter, SubmitPayload, SubmissionAck, SubmitterHealth } from '../submitter.js';

export interface RpcSubmitterOpts {
  rpcPool: RpcPool;
}

export class RpcSubmitter implements Submitter {
  readonly name = 'rpc';
  readonly kind = 'rpc' as const;
  readonly #rpcPool: RpcPool;
  #lastOkAt = 0;

  constructor(opts: RpcSubmitterOpts) {
    this.#rpcPool = opts.rpcPool;
  }

  async submit(payload: SubmitPayload): Promise<SubmissionAck> {
    if (payload.kind !== 'tx') {
      throw new Error('RpcSubmitter only handles single-tx payloads; use JitoSubmitter for bundles');
    }

    // Pin the best endpoint for write affinity (lowest EWMA, non-unhealthy).
    // We don't call on the descriptor itself — `rpcPool.call()` routes through
    // the pool's transport layer. `pinForWrite()` is called to warm the pool's
    // selection heuristic and surface config errors (circuit_open) early.
    this.#rpcPool.pinForWrite();

    const sig = await this.#rpcPool.call('sendTransaction', [
      base58.encode(payload.signedTx),
      { skipPreflight: true, maxRetries: 0, encoding: 'base58' },
    ]);

    this.#lastOkAt = Date.now();
    return { kind: 'tx', signature: sig as string, submitterUsed: this.name };
  }

  health(): SubmitterHealth {
    return { state: 'healthy', lastOkAt: this.#lastOkAt };
  }
}
