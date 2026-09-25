import * as grpc from '@grpc/grpc-js';
import type { PublicKey } from '@ap3x/solana-core';
import { loadSearcherProto, PINNED_COMMIT } from '../proto/load.js';
import { HealthTracker, type Submitter, type SubmitPayload, type SubmissionAck, type SubmitterHealth } from '../submitter.js';

export interface JitoGrpcSubmitterOpts {
  /** Block engine gRPC endpoint in `host:port` form, e.g. `mainnet.block-engine.jito.wtf:443`. */
  grpcEndpoint: string;
  /** Jito tip account (informational — the executor adds the tip transfer). */
  tipAccount: PublicKey;
  /** Optional bearer auth token, sent as `authorization` metadata on each call. */
  authToken?: string;
  /**
   * Use TLS (default true — the public block engines only accept TLS). Set
   * false only for a local plaintext endpoint.
   */
  tls?: boolean;
  /** How long a failure marks this submitter unhealthy (default 30s). */
  unhealthyCooldownMs?: number;
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
  readonly #metadata: grpc.Metadata;
  readonly #health: HealthTracker;

  constructor(opts: JitoGrpcSubmitterOpts) {
    if (opts.protoCommit !== undefined && opts.protoCommit !== PINNED_COMMIT) {
      throw new Error(
        `Jito proto commit mismatch: expected ${PINNED_COMMIT}, got ${opts.protoCommit}`,
      );
    }

    const { SearcherService } = loadSearcherProto();
    this.client = new SearcherService(
      opts.grpcEndpoint,
      opts.tls === false ? grpc.credentials.createInsecure() : grpc.credentials.createSsl(),
    );
    this.#metadata = new grpc.Metadata();
    if (opts.authToken) this.#metadata.set('authorization', `Bearer ${opts.authToken}`);
    this.#health = new HealthTracker(opts.unhealthyCooldownMs);
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

    return this.#health.track(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ack: any = await new Promise((res, rej) => {
        this.client.sendBundle(
          request,
          this.#metadata,
          (err: Error | null, response: unknown) => (err ? rej(err) : res(response)),
        );
      });
      if (!ack?.uuid) throw new Error('jito-grpc: response has no bundle uuid');
      return { kind: 'bundle' as const, bundleId: ack.uuid as string, submitterUsed: this.name };
    });
  }

  health(): SubmitterHealth {
    return this.#health.health();
  }
}
