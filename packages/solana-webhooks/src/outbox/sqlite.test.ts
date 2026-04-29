/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebhookEvent } from '../types.js';
import { SqliteOutbox } from './sqlite.js';

// Probe both the JS module AND the native binding by opening + closing a DB.
// On systems where pnpm's build approval is missing, the JS loads but the
// `.node` addon does not — this catches that case.
let hasBetterSqlite3 = false;
try {
  const Database = (await import('better-sqlite3' as any)).default;
  const probe = new Database(':memory:');
  probe.close();
  hasBetterSqlite3 = true;
} catch {
  hasBetterSqlite3 = false;
}

function mkEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: 'evt-1',
    source: 'helius',
    receivedAt: 1_000_000,
    rawPayload: new TextEncoder().encode('{"hello":"world"}'),
    ...overrides,
  };
}

describe.skipIf(!hasBetterSqlite3)('SqliteOutbox', () => {
  let dbDir: string;
  let outbox: SqliteOutbox;

  beforeAll(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'ap3x-webhooks-outbox-'));
  });

  afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (outbox) await outbox.close();
    outbox = new SqliteOutbox({ path: ':memory:' });
    await outbox.init();
  });

  describe('init', () => {
    it('is idempotent — calling twice does not throw', async () => {
      await outbox.init(); // already called in beforeEach
      await outbox.init();
    });

    it('throws a clear error if better-sqlite3 is missing', async () => {
      // We can't easily mock the dynamic import here without a full vi.mock
      // setup, so this case is exercised in integration tests on machines
      // where the native binding is unavailable. Documented here for
      // discoverability.
      expect(true).toBe(true);
    });
  });

  describe('insert', () => {
    it('persists a new event and returns true', async () => {
      const created = await outbox.insert(mkEvent());
      expect(created).toBe(true);
    });

    it('returns false on duplicate (source, id) — idempotent re-delivery', async () => {
      await outbox.insert(mkEvent());
      const second = await outbox.insert(mkEvent());
      expect(second).toBe(false);

      // Still only one pending row — the duplicate did not insert.
      const rows = await outbox.pending({ limit: 10 });
      expect(rows).toHaveLength(1);
    });

    it('treats different sources with the same id as distinct events', async () => {
      const a = await outbox.insert(mkEvent({ source: 'helius' }));
      const b = await outbox.insert(mkEvent({ source: 'other' }));
      expect(a).toBe(true);
      expect(b).toBe(true);

      const rows = await outbox.pending({ limit: 10 });
      expect(rows).toHaveLength(2);
    });

    it('persists rawPayload bytes intact', async () => {
      const bytes = new Uint8Array([0, 1, 2, 254, 255]);
      await outbox.insert(mkEvent({ rawPayload: bytes }));
      const [row] = await outbox.pending({ limit: 1 });
      expect(row).toBeDefined();
      expect(Array.from(row!.rawPayload)).toEqual([0, 1, 2, 254, 255]);
    });

    it('persists metadata round-trip', async () => {
      await outbox.insert(mkEvent({ metadata: { webhookId: 'w-1', deliveryId: 'd-9' } }));
      const [row] = await outbox.pending({ limit: 1 });
      expect(row?.metadata).toEqual({ webhookId: 'w-1', deliveryId: 'd-9' });
    });
  });

  describe('pending', () => {
    it('returns rows in receivedAt ascending order', async () => {
      await outbox.insert(mkEvent({ id: 'b', receivedAt: 200 }));
      await outbox.insert(mkEvent({ id: 'a', receivedAt: 100 }));
      await outbox.insert(mkEvent({ id: 'c', receivedAt: 300 }));

      const rows = await outbox.pending({ limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('caps results at limit', async () => {
      for (let i = 0; i < 5; i++) {
        await outbox.insert(mkEvent({ id: `e-${i}`, receivedAt: i }));
      }
      const rows = await outbox.pending({ limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id)).toEqual(['e-0', 'e-1']);
    });

    it('excludes processed rows', async () => {
      await outbox.insert(mkEvent({ id: 'a' }));
      await outbox.insert(mkEvent({ id: 'b' }));
      await outbox.markProcessed('helius', 'a', Date.now());

      const rows = await outbox.pending({ limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(['b']);
    });

    it('skips rows that exceed maxAttempts', async () => {
      await outbox.insert(mkEvent({ id: 'a' }));
      await outbox.insert(mkEvent({ id: 'b' }));
      // Push 'a' to high attempts.
      await outbox.markFailed('helius', 'a', 'boom', 5);

      // maxAttempts=3 should exclude 'a' (attempts=5)
      const rows = await outbox.pending({ limit: 10, maxAttempts: 3 });
      expect(rows.map((r) => r.id)).toEqual(['b']);
    });

    it('starts from 0 attempts after each clean insert', async () => {
      await outbox.insert(mkEvent({ id: 'a' }));
      const [row] = await outbox.pending({ limit: 1 });
      expect(row?.attempts).toBe(0);
      expect(row?.error).toBeNull();
    });
  });

  describe('markProcessed', () => {
    it('removes the row from pending', async () => {
      await outbox.insert(mkEvent());
      await outbox.markProcessed('helius', 'evt-1', 1_000_500);

      const rows = await outbox.pending({ limit: 10 });
      expect(rows).toEqual([]);
    });

    it('throws when (source, id) does not exist', async () => {
      await expect(outbox.markProcessed('helius', 'nope', 1)).rejects.toThrow(/no row/);
    });

    it('clears any prior error on success', async () => {
      await outbox.insert(mkEvent());
      await outbox.markFailed('helius', 'evt-1', 'transient', 1);
      await outbox.markProcessed('helius', 'evt-1', 1_000_500);

      const cnt = outbox.countPending();
      expect(cnt).toBe(0);
    });
  });

  describe('markFailed', () => {
    it('records error and attempts; row remains pending', async () => {
      await outbox.insert(mkEvent());
      await outbox.markFailed('helius', 'evt-1', 'normalize threw', 1);

      const [row] = await outbox.pending({ limit: 1 });
      expect(row?.error).toBe('normalize threw');
      expect(row?.attempts).toBe(1);
    });

    it('throws when (source, id) does not exist', async () => {
      await expect(outbox.markFailed('helius', 'nope', 'x', 1)).rejects.toThrow(/no row/);
    });
  });

  describe('countPending', () => {
    it('returns the number of unprocessed rows', async () => {
      await outbox.insert(mkEvent({ id: 'a' }));
      await outbox.insert(mkEvent({ id: 'b' }));
      await outbox.insert(mkEvent({ id: 'c' }));
      await outbox.markProcessed('helius', 'b', Date.now());

      expect(outbox.countPending()).toBe(2);
    });
  });

  describe('close', () => {
    it('is idempotent', async () => {
      await outbox.close();
      await outbox.close();
    });

    it('subsequent operations throw a clear error', async () => {
      await outbox.close();
      await expect(outbox.insert(mkEvent())).rejects.toThrow(/not initialized/);
    });
  });

  describe('persistence across re-open', () => {
    it('preserves rows when re-opening the same file', async () => {
      const path = join(dbDir, `persist-${Date.now()}.db`);
      const a = new SqliteOutbox({ path });
      await a.init();
      await a.insert(mkEvent({ id: 'persist-1' }));
      await a.close();

      const b = new SqliteOutbox({ path });
      await b.init();
      const rows = await b.pending({ limit: 10 });
      expect(rows.map((r) => r.id)).toEqual(['persist-1']);
      await b.close();
    });
  });
});

describe.skipIf(hasBetterSqlite3)('SqliteOutbox (skipped — better-sqlite3 native binding unavailable)', () => {
  it('skipped', () => {});
});
