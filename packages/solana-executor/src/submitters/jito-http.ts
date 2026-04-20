import { HttpClient, base58, type PublicKey } from '@ap3x/solana-core';
import type { Submitter, SubmitPayload, SubmissionAck, SubmitterHealth } from '../submitter.js';

export interface JitoHttpSubmitterOpts {
  httpClient: HttpClient;
  blockEngineUrl: string;
  tipAccount: PublicKey;
  authToken?: string;
}

export class JitoHttpSubmitter implements Submitter {
  readonly name = 'jito-http';
  readonly kind = 'jito-http' as const;
  private lastOkAt = 0;

  constructor(private readonly opts: JitoHttpSubmitterOpts) {}

  async submit(payload: SubmitPayload): Promise<SubmissionAck> {
    if (payload.kind !== 'bundle') {
      throw new Error('JitoHttpSubmitter only handles bundle payloads');
    }

    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [payload.signedTxs.map((tx) => base58.encode(tx))],
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.authToken) {
      headers['Authorization'] = `Bearer ${this.opts.authToken}`;
    }

    // HttpClient.post returns a native Fetch Response. Read the body as text
    // then parse — avoids a second body-read if we need to inspect on error.
    const response = await this.opts.httpClient.post(
      `${this.opts.blockEngineUrl}/api/v1/bundles`,
      body,
      { headers },
    );

    const text = await response.text();
    const parsed = JSON.parse(text) as { result?: string; error?: { message: string } };

    if (parsed.error) {
      throw new Error(`jito-http error: ${parsed.error.message}`);
    }

    this.lastOkAt = Date.now();
    return { kind: 'bundle', bundleId: parsed.result!, submitterUsed: this.name };
  }

  health(): SubmitterHealth {
    return { state: 'healthy', lastOkAt: this.lastOkAt };
  }
}
