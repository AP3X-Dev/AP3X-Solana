import type {
  IncomingRequest,
  RawWebhookEvent,
  TypedSolanaEvent,
  VerifyResult,
  WebhookDriver,
} from '../../types.js';
import { verifyAuthHeader } from '../../server/auth.js';
import { normalizeHeliusTx, type HeliusEnhancedTx } from './normalize.js';
import { HeliusCatchup, type HeliusCatchupOptions } from './catchup.js';
import { HeliusAdmin, type HeliusAdminOptions } from './admin.js';

/** Stable identifier for this driver. Used as the `source` column in the outbox. */
export const HELIUS_SOURCE = 'helius' as const;

export interface HeliusDriverOptions {
  /**
   * Shared secret configured in Helius's webhook dashboard. The webhook sends
   * it as the raw `Authorization` header value on every request — see the
   * `verifyAuthHeader` doc-comment for why this isn't HMAC-of-body.
   */
  secret: string;
  /**
   * Optional catchup configuration. When provided, the driver exposes a
   * `catchup` client backed by Helius's enhanced-tx REST API for gap replay.
   * Apps that don't need catchup omit this and the field stays unset.
   */
  catchup?: HeliusCatchupOptions;
  /**
   * Optional admin configuration. When provided, the driver exposes an
   * `admin` client for Helius's webhook-management API
   * (subscribe / remove / reconcile addresses).
   */
  admin?: HeliusAdminOptions;
}

/**
 * Helius webhook driver. Implements the {@link WebhookDriver} contract:
 *   - verifyRequest → constant-time compare of Authorization header
 *   - parseRawPayload → split a JSON array of enhanced-tx records into
 *     one {@link RawWebhookEvent} per tx, keyed by signature
 *   - normalizeEvent → map one Helius tx to one or more
 *     {@link TypedSolanaEvent}s via {@link normalizeHeliusTx}
 *
 * `admin` and `catchup` are not set yet — they ship in subsequent updates.
 * Apps that need either today implement them externally and call into the
 * driver's normalize layer directly.
 */
export function createHeliusDriver(opts: HeliusDriverOptions): WebhookDriver {
  const driver: WebhookDriver = {
    source: HELIUS_SOURCE,

    verifyRequest(req: IncomingRequest): VerifyResult {
      return verifyAuthHeader(req, opts.secret);
    },

    parseRawPayload(body: Uint8Array): RawWebhookEvent[] {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8').decode(body));
      } catch {
        // Bad JSON → empty list. The receiver layer surfaces parse failure
        // via driver.parseRawPayload throwing; returning [] is the silent-
        // drop alternative for malformed-but-syntactically-JSON inputs that
        // happen to lack any usable record. We keep this lenient because the
        // receiver's own try/catch already distinguishes "throws" from "no
        // events" — a syntactically-broken body is a 400 (parse rejection),
        // an empty array is a 200 with eventCount=0.
        throw new Error('helius: payload is not valid JSON');
      }

      // Helius always sends an array; defensively accept a single object too.
      const arr = Array.isArray(parsed) ? parsed : [parsed];

      const out: RawWebhookEvent[] = [];
      for (const tx of arr) {
        if (!tx || typeof tx !== 'object') continue;
        const sig = (tx as { signature?: unknown }).signature;
        if (typeof sig !== 'string' || sig.length === 0) continue;
        out.push({
          id: `helius:${sig}`,
          source: HELIUS_SOURCE,
          payload: tx,
        });
      }
      return out;
    },

    normalizeEvent(raw: RawWebhookEvent): TypedSolanaEvent[] {
      // raw.payload is the Helius enhanced-tx object stored in the outbox.
      // We trust the driver-internal wiring — parseRawPayload above is the
      // only producer.
      return normalizeHeliusTx(raw.payload as HeliusEnhancedTx);
    },
  };

  if (opts.catchup) {
    driver.catchup = new HeliusCatchup(opts.catchup);
  }
  if (opts.admin) {
    driver.admin = new HeliusAdmin(opts.admin);
  }

  return driver;
}
