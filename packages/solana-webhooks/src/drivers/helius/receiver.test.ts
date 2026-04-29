import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IncomingRequest } from '../../types.js';
import { createHeliusDriver, HELIUS_SOURCE } from './receiver.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'tests', 'fixtures',
);

function readBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, rel)));
}

function mkReq(overrides: Partial<IncomingRequest> = {}): IncomingRequest {
  return {
    method: 'POST',
    url: '/webhook',
    headers: {},
    body: new Uint8Array(),
    ...overrides,
  };
}

describe('createHeliusDriver — verifyRequest', () => {
  const driver = createHeliusDriver({ secret: 'shared' });

  it('accepts requests with the matching Authorization header', () => {
    const req = mkReq({ headers: { authorization: 'shared' } });
    expect(driver.verifyRequest(req)).toEqual({ ok: true });
  });

  it('rejects bare requests', () => {
    expect(driver.verifyRequest(mkReq())).toEqual({ ok: false, reason: 'missing-auth' });
  });

  it('rejects mismatched secret', () => {
    const req = mkReq({ headers: { authorization: 'wrong' } });
    expect(driver.verifyRequest(req)).toEqual({ ok: false, reason: 'invalid-auth' });
  });
});

describe('createHeliusDriver — parseRawPayload', () => {
  const driver = createHeliusDriver({ secret: 'x' });

  it('parses an array of enhanced-tx records', () => {
    const body = readBytes('helius_webhook_batch.json');
    const events = driver.parseRawPayload(body);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.source).toBe(HELIUS_SOURCE);
      expect(e.id.startsWith('helius:')).toBe(true);
    }
  });

  it('parses a single object body (defensive — wraps in array)', () => {
    const body = new TextEncoder().encode(JSON.stringify({
      signature: 'sig-single',
      type: 'SWAP',
      transactionError: null,
    }));
    const events = driver.parseRawPayload(body);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('helius:sig-single');
  });

  it('skips records without a signature', () => {
    const body = new TextEncoder().encode(JSON.stringify([
      { signature: 'has-sig', type: 'SWAP' },
      { type: 'SWAP' }, // no signature → skipped
      { signature: '' }, // empty signature → skipped
    ]));
    const events = driver.parseRawPayload(body);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('helius:has-sig');
  });

  it('throws on syntactically-broken JSON', () => {
    const body = new TextEncoder().encode('%%%-not-json');
    expect(() => driver.parseRawPayload(body)).toThrow(/not valid JSON/);
  });

  it('returns empty array for empty array input', () => {
    const body = new TextEncoder().encode('[]');
    expect(driver.parseRawPayload(body)).toEqual([]);
  });
});

describe('createHeliusDriver — normalizeEvent', () => {
  const driver = createHeliusDriver({ secret: 'x' });

  it('round-trips parseRawPayload → normalizeEvent for the batch fixture', () => {
    const body = readBytes('helius_webhook_batch.json');
    const raw = driver.parseRawPayload(body);
    expect(raw.length).toBeGreaterThan(0);
    const normalized = raw.flatMap((r) => driver.normalizeEvent(r));
    expect(normalized.length).toBe(raw.length); // each Helius tx → one substrate event
    for (const ev of normalized) {
      expect(typeof ev.signature).toBe('string');
      expect(typeof ev.slot).toBe('number');
      expect(['decoded', 'unknown']).toContain(ev.kind);
    }
  });
});
