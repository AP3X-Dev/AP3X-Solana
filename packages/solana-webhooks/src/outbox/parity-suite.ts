// Behavioural parity suite — every Outbox backend must satisfy these tests.
// SQLite, Postgres, and any future backend share this suite to prove they
// cannot drift from one another or from the contract documented on the
// Outbox interface.
//
// Backends provide a factory that yields a fresh, empty Outbox plus a
// cleanup hook for any external state (DB connections, files). The suite
// drives the public Outbox interface only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebhookEvent } from '../types.js';
import type { Outbox } from './store.js';

export interface ParityFixture {
  outbox: Outbox;
  cleanup?: () => Promise<void> | void;
}

export type ParityFactory = () => Promise<ParityFixture>;

function mkEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: 'evt-1',
    source: 'helius',
    receivedAt: 1_000_000,
    rawPayload: new TextEncoder().encode('{"hello":"world"}'),
    ...overrides,
  };
}

export function runOutboxParitySuite(name: string, factory: ParityFactory): void {
  describe(`${name} — parity`, () => {
    let fixture: ParityFixture;
    let outbox: Outbox;

    beforeEach(async () => {
      fixture = await factory();
      outbox = fixture.outbox;
    });

    afterEach(async () => {
      if (fixture?.cleanup) await fixture.cleanup();
    });

    // ── insert ─────────────────────────────────────────────────────

    it('insert returns true for a new event', async () => {
      expect(await outbox.insert(mkEvent())).toBe(true);
    });

    it('insert returns false for a duplicate (source, id) — idempotent re-delivery', async () => {
      await outbox.insert(mkEvent());
      expect(await outbox.insert(mkEvent())).toBe(false);
    });

    it('insert distinguishes events by source even when ids match', async () => {
      expect(await outbox.insert(mkEvent({ source: 'helius' }))).toBe(true);
      expect(await outbox.insert(mkEvent({ source: 'other'  }))).toBe(true);
      const rows = await outbox.pending({ limit: 10 });
      expect(rows.length).toBe(2);
    });

    it('insert preserves rawPayload bytes intact', async () => {
      const bytes = new Uint8Array([0, 1, 2, 254, 255]);
      await outbox.insert(mkEvent({ rawPayload: bytes }));
      const [row] = await outbox.pending({ limit: 1 });
      expect(Array.from(row!.rawPayload)).toEqual([0, 1, 2, 254, 255]);
    });

    it('insert preserves metadata round-trip', async () => {
      await outbox.insert(mkEvent({ metadata: { webhookId: 'w-1', deliveryId: 'd-9' } }));
      const [row] = await outbox.pending({ limit: 1 });
      expect(row?.metadata).toEqual({ webhookId: 'w-1', deliveryId: 'd-9' });
    });

    // ── pending ────────────────────────────────────────────────────

    it('pending returns rows in receivedAt ascending order', async () => {
      await outbox.insert(mkEvent({ id: 'b', receivedAt: 200 }));
      await outbox.insert(mkEvent({ id: 'a', receivedAt: 100 }));
      await outbox.insert(mkEvent({ id: 'c', receivedAt: 300 }));
      const rows = await outbox.pending({ limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('pending caps results at limit', async () => {
      for (let i = 0; i < 5; i++) {
        await outbox.insert(mkEvent({ id: `e-${i}`, receivedAt: i }));
      }
      const rows = await outbox.pending({ limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id)).toEqual(['e-0', 'e-1']);
    });

    it('pending excludes processed rows', async () => {
      await outbox.insert(mkEvent({ id: 'a' }));
      await outbox.insert(mkEvent({ id: 'b' }));
      await outbox.markProcessed('helius', 'a', Date.now());
      const rows = await outbox.pending({ limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(['b']);
    });

    it('pending skips rows that exceed maxAttempts', async () => {
      await outbox.insert(mkEvent({ id: 'a' }));
      await outbox.insert(mkEvent({ id: 'b' }));
      await outbox.markFailed('helius', 'a', 'boom', 5);
      const rows = await outbox.pending({ limit: 10, maxAttempts: 3 });
      expect(rows.map((r) => r.id)).toEqual(['b']);
    });

    it('pending returns rows with attempts=0 and error=null after a clean insert', async () => {
      await outbox.insert(mkEvent({ id: 'a' }));
      const [row] = await outbox.pending({ limit: 1 });
      expect(row?.attempts).toBe(0);
      expect(row?.error).toBeNull();
    });

    // ── markProcessed ──────────────────────────────────────────────

    it('markProcessed removes the row from pending', async () => {
      await outbox.insert(mkEvent());
      await outbox.markProcessed('helius', 'evt-1', 1_000_500);
      const rows = await outbox.pending({ limit: 10 });
      expect(rows).toEqual([]);
    });

    it('markProcessed throws when (source, id) does not exist', async () => {
      await expect(outbox.markProcessed('helius', 'nope', 1)).rejects.toThrow(/no row/);
    });

    // ── markFailed ─────────────────────────────────────────────────

    it('markFailed records error and attempts; row remains pending', async () => {
      await outbox.insert(mkEvent());
      await outbox.markFailed('helius', 'evt-1', 'normalize threw', 1);
      const [row] = await outbox.pending({ limit: 1 });
      expect(row?.error).toBe('normalize threw');
      expect(row?.attempts).toBe(1);
    });

    it('markFailed throws when (source, id) does not exist', async () => {
      await expect(outbox.markFailed('helius', 'nope', 'x', 1)).rejects.toThrow(/no row/);
    });

    // ── close idempotency ──────────────────────────────────────────

    it('close is idempotent', async () => {
      await outbox.close();
      await outbox.close();
    });
  });
}
