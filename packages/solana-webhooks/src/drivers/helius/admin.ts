import type { WebhookAdminClient } from '../../types.js';

/** Default base URL for Helius's webhook management API. */
export const DEFAULT_HELIUS_ADMIN_BASE_URL = 'https://api.helius.xyz';

export interface HeliusAdminOptions {
  /** Helius API key. */
  apiKey: string;
  /** Override the API base URL — useful for tests / mirrors. */
  baseUrl?: string;
  /** Fetch implementation override — defaults to the runtime's `fetch`. */
  fetch?: typeof fetch;
}

/**
 * One Helius webhook's mutable state, as returned by `GET /v0/webhooks/{id}`.
 * The Helius API returns more fields than this; we read only what subscribe /
 * remove / reconcile mutates and pass the rest through unchanged on the PUT
 * back so we don't accidentally truncate config the operator set elsewhere.
 */
interface HeliusWebhookConfig {
  webhookID?: string;
  accountAddresses?: string[];
  // Pass-through bag for fields we don't touch (transactionTypes, webhookURL,
  // authHeader, encoding, txnStatus, etc.).
  [key: string]: unknown;
}

/**
 * Implements {@link WebhookAdminClient} via Helius's webhook-management REST
 * API. Every method is idempotent and read-modify-write: GET the current
 * config, compute the desired `accountAddresses` set, PUT the merged config
 * back. The pattern means concurrent admin calls last-write-wins on the
 * address set — ops should serialise admin calls if that matters.
 */
export class HeliusAdmin implements WebhookAdminClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly _fetch: typeof fetch;

  constructor(opts: HeliusAdminOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_HELIUS_ADMIN_BASE_URL;
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  async subscribeAddresses(webhookId: string, addresses: string[]): Promise<void> {
    const current = await this.getConfig(webhookId);
    const set = new Set(current.accountAddresses ?? []);
    for (const a of addresses) set.add(a);
    await this.putConfig(webhookId, { ...current, accountAddresses: [...set] });
  }

  async removeAddresses(webhookId: string, addresses: string[]): Promise<void> {
    const current = await this.getConfig(webhookId);
    const remove = new Set(addresses);
    const next = (current.accountAddresses ?? []).filter((a) => !remove.has(a));
    await this.putConfig(webhookId, { ...current, accountAddresses: next });
  }

  async reconcile(
    webhookId: string,
    desired: string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    const current = await this.getConfig(webhookId);
    const have = new Set(current.accountAddresses ?? []);
    const want = new Set(desired);

    const added:   string[] = [];
    const removed: string[] = [];
    for (const a of want) if (!have.has(a)) added.push(a);
    for (const a of have) if (!want.has(a)) removed.push(a);

    if (added.length === 0 && removed.length === 0) {
      return { added: [], removed: [] };
    }

    await this.putConfig(webhookId, { ...current, accountAddresses: [...want] });
    return { added, removed };
  }

  // ── HTTP helpers ─────────────────────────────────────────────────

  private async getConfig(webhookId: string): Promise<HeliusWebhookConfig> {
    const url = new URL(`/v0/webhooks/${encodeURIComponent(webhookId)}`, this.baseUrl);
    url.searchParams.set('api-key', this.apiKey);
    const res = await this._fetch(url.toString(), { method: 'GET' });
    if (!res.ok) {
      throw new Error(`HeliusAdmin.getConfig: ${res.status} ${res.statusText} for webhookId=${webhookId}`);
    }
    return (await res.json()) as HeliusWebhookConfig;
  }

  private async putConfig(webhookId: string, config: HeliusWebhookConfig): Promise<void> {
    const url = new URL(`/v0/webhooks/${encodeURIComponent(webhookId)}`, this.baseUrl);
    url.searchParams.set('api-key', this.apiKey);
    // Strip the readback-only field — Helius's PUT rejects unknown keys in
    // some configurations, and `webhookID` is the URL parameter.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { webhookID: _readback, ...body } = config;
    const res = await this._fetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HeliusAdmin.putConfig: ${res.status} ${res.statusText} for webhookId=${webhookId}`);
    }
  }
}
