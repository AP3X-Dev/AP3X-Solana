/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from 'vitest';
import { SqliteOutbox } from './sqlite.js';
import { runOutboxParitySuite } from './parity-suite.js';

let hasBetterSqlite3 = false;
try {
  const Database = (await import('better-sqlite3' as any)).default;
  const probe = new Database(':memory:');
  probe.close();
  hasBetterSqlite3 = true;
} catch {
  hasBetterSqlite3 = false;
}

if (hasBetterSqlite3) {
  runOutboxParitySuite('SqliteOutbox (:memory:)', async () => {
    const outbox = new SqliteOutbox({ path: ':memory:' });
    await outbox.init();
    return { outbox, cleanup: async () => outbox.close() };
  });
} else {
  describe.skip('SqliteOutbox — parity', () => {
    it('skipped: better-sqlite3 native binding unavailable', () => {});
  });
}
