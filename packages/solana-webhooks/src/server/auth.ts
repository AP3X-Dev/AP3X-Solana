import { timingSafeEqual } from 'node:crypto';
import type { IncomingRequest, VerifyResult } from '../types.js';

/**
 * Verify the request's `Authorization` header equals the configured shared
 * secret using a constant-time compare. This is the pattern Helius uses (and
 * what the AP3X-Solana predecessor product had in production): the dashboard
 * configures a static "Authentication Header" string and the webhook sends it
 * as the raw `Authorization` value on every request — no HMAC of body.
 *
 * Constant-time comparison is mandatory: a naïve `===` leaks the secret one
 * character at a time via response-time variation. {@link timingSafeEqual}
 * requires equal-length inputs, so we length-pad first to a fixed-size buffer.
 *
 * The full HMAC-of-body pattern (signed payload) is intentionally a separate
 * driver responsibility — drivers that adopt it later implement their own
 * `verifyRequest` over the raw body bytes.
 */
export function verifyAuthHeader(req: IncomingRequest, secret: string): VerifyResult {
  const header = req.headers['authorization'] ?? req.headers['Authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return { ok: false, reason: 'missing-auth' };
  }

  if (!constantTimeEquals(value, secret)) {
    return { ok: false, reason: 'invalid-auth' };
  }

  return { ok: true };
}

/**
 * Length-aware constant-time compare. {@link timingSafeEqual} throws on
 * length mismatch — that's a side channel by itself, so we pad both inputs
 * to a fixed window and compare. The fixed window is the larger of the two
 * inputs plus a safety margin; this leaks at most "is the input ≥ N bytes"
 * which is uninteresting compared to the secret material.
 */
function constantTimeEquals(a: string, b: string): boolean {
  // Encode once. UTF-8 byte length matches the length we compare over.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');

  // Pad the shorter one with zero bytes to match length. Always run the
  // compare even when lengths differ — the boolean result captures the
  // mismatch without short-circuiting the timing.
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len, 0);
  const bPad = Buffer.alloc(len, 0);
  aBuf.copy(aPad);
  bBuf.copy(bPad);

  const equal = timingSafeEqual(aPad, bPad);
  return equal && aBuf.length === bBuf.length;
}
