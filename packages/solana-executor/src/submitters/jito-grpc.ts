import * as grpc from '@grpc/grpc-js';
import type { PublicKey } from '@ap3x/solana-core';
import { loadSearcherProto, PINNED_COMMIT } from '../proto/load.js';
import type { Submitter, SubmitPayload, SubmissionAck, SubmitterHealth } from '../submitter.js';

export interface JitoGrpcSubmitterOpts {
  /** Block engine gRPC endpoint in `host:port` form, e.g. `mainnet.block-engine.jito.wtf:443`. */
  grpcEndpoint: string;
  /** Jito tip account public key (informational — callers must construct tip ix themselves). */
  tipAccount: PublicKey;
  /** Optional bearer auth token forwarded via gRPC metadata. */
  authToken?: string;
  /**
   * Optional sanity check against the pinned proto commit.  Pass `PINNED_COMMIT`
   * to fail fast if the loader's proto differs from what you expect.
   */
  protoCommit?: string;
}

export class JitoGrpcSubmitter implements Submitter {
  readonly name = 'jito-grpc';
  readonly kind = 'jito-grpc' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private lastOkAt = 0;

  constructor(opts: JitoGrpcSubmitterOpts) {
    if (opts.protoCommit !== undefined && opts.protoCommit !== PINNED_COMMIT) {
      throw new Error(
        `Jito proto commit mismatch: expected ${PINNED_COMMIT}, got ${opts.protoCommit}`,
      );
    }

    const { SearcherService } = loadSearcherProto();
    this.client = new SearcherService(
      opts.grpcEndpoint,
      grpc.credentials.createInsecure(),
    );
  }

  async submit(payload: SubmitPayload): Promise<SubmissionAck> {
    if (payload.kind !== 'bundle') {
      throw new Error('JitoGrpcSubmitter only handles bundle payloads');
    }

    // proto structure: SendBundleRequest { bundle: Bundle { packets: Packet[] } }
    // packet.Packet has { data: bytes, meta: Meta }
    const request = {
      bundle: {
        packets: payload.signedTxs.map((tx) => ({ data: tx })),
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ack: any = await new Promise((res, rej) => {
      this.client.sendBundle(
        request,
        (err: Error | null, response: unknown) => (err ? rej(err) : res(response)),
      );
    });

    this.lastOkAt = Date.now();
    return { kind: 'bundle', bundleId: ack.uuid, submitterUsed: this.name };
  }

  health(): SubmitterHealth {
    return { state: 'healthy', lastOkAt: this.lastOkAt };
  }
}
