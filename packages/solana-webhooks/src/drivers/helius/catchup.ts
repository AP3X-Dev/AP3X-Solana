import type { TypedSolanaEvent, WebhookCatchupClient } from '../../types.js';
import { normalizeHeliusTx, type HeliusEnhancedTx } from './normalize.js';

/**
 * Default Helius enhanced-tx API base URL. Catchup hits
 * `${baseUrl}/v0/addresses/{addr}/transactions` and pages via the `before`
 * signature cursor returned by the API.
 */
export const DEFAULT_HELIUS_BASE_URL = 'https://api.helius.xyz';

export interface HeliusCatchupOptions {
  /** Helius API key. */
  apiKey: string;
  /** Override the API base URL — useful for tests / Helius-compatible mirrors. */
  baseUrl?: string;
  /** Fetch implementation override — defaults to the runtime's `fetch`. */
  fetch?: typeof fetch;
  /**
   * Page size for each enhanced-tx request. The API caps this at 100; values
   * above that are silently clamped server-side. Default 100.
   */
  pageSize?: number;
  /** Hard ceiling on total pages fetched for one fetchRange call. Default Infinity. */
  maxPages?: number;
}

/**
 * Implements {@link WebhookCatchupClient} via Helius's enhanced-tx REST API.
 * The endpoint returns the same parsed-tx shape Helius webhooks deliver, so
 * the catchup path reuses {@link normalizeHeliusTx} verbatim.
 *
 * Pagination: the API returns transactions newest-first. `fetchRange` pages
 * in that direction using the `before` signature cursor and stops when:
 *   - a transaction's slot drops below `fromSlot` (when set)
 *   - `limit` events have been yielded
 *   - the API returns an empty page
 *   - `maxPages` is reached
 *
 * Transactions newer than `toSlot` (when set) are skipped — early pages may
 * legitimately contain them.
 */
export class HeliusCatchup implements WebhookCatchupClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly _fetch: typeof fetch;

  constructor(opts: HeliusCatchupOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_HELIUS_BASE_URL;
    this.pageSize = Math.min(opts.pageSize ?? 100, 100);
    this.maxPages = opts.maxPages ?? Infinity;
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  async *fetchRange(args: {
    address: string;
    fromSlot?: number;
    toSlot?: number;
    limit?: number;
  }): AsyncIterable<TypedSolanaEvent> {
    let beforeSignature: string | undefined;
    let pages = 0;
    let yielded = 0;
    const limit = args.limit ?? Infinity;

    while (pages < this.maxPages && yielded < limit) {
      const txs = await this.fetchPage(args.address, beforeSignature);
      if (txs.length === 0) return;
      pages += 1;

      let pageHadInRangeTx = false;

      for (const tx of txs) {
        const slot = typeof tx.slot === 'number' ? tx.slot : 0;

        // Skip transactions newer than the upper bound — early pages may
        // include them.
        if (args.toSlot !== undefined && slot > args.toSlot) continue;

        // Stop when we've descended below the lower bound. Pages are
        // newest-first, so once we're below fromSlot we won't go back up.
        if (args.fromSlot !== undefined && slot < args.fromSlot) return;

        pageHadInRangeTx = true;
        for (const event of normalizeHeliusTx(tx)) {
          yield event;
          yielded += 1;
          if (yielded >= limit) return;
        }
      }

      // Cursor for next page: the last signature in this page (oldest of
      // this batch). If the page returned without any in-range tx and we
      // haven't hit fromSlot yet, we still want to keep paging in case
      // earlier pages re-enter the [fromSlot, toSlot] window.
      const last = txs[txs.length - 1];
      if (!last || !last.signature) return;
      beforeSignature = last.signature;

      // If the entire page was above toSlot and we've moved on, that's fine.
      // If the entire page was below fromSlot, the early-return inside the
      // loop already handled it — `pageHadInRangeTx` is just for telemetry
      // and isn't required for correctness.
      void pageHadInRangeTx;
    }
  }

  private async fetchPage(address: string, before?: string): Promise<HeliusEnhancedTx[]> {
    const url = new URL(`/v0/addresses/${encodeURIComponent(address)}/transactions`, this.baseUrl);
    url.searchParams.set('api-key', this.apiKey);
    url.searchParams.set('limit', String(this.pageSize));
    if (before) url.searchParams.set('before', before);

    const res = await this._fetch(url.toString());
    if (!res.ok) {
      throw new Error(`HeliusCatchup: enhanced-tx API returned ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      throw new Error('HeliusCatchup: enhanced-tx API returned non-array body');
    }
    return body as HeliusEnhancedTx[];
  }
}
