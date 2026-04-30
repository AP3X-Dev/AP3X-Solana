// Real-Postgres parity test. Opt-in via the AP3X_PG_URL env var; skipped
// otherwise. CI runs this against PG 14/15/16 service containers.

import { describe, it } from 'vitest';
import { PostgresOutbox } from './postgres.js';
import { runOutboxParitySuite } from './parity-suite.js';

const PG_URL = process.env['AP3X_PG_URL'];

if (PG_URL) {
  runOutboxParitySuite('PostgresOutbox (real)', async () => {
    // Each test gets a fresh schema-prefixed table so iterations don't bleed.
    const schema = `webhooks_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const outbox = new PostgresOutbox({ connectionString: PG_URL, schema });
    await outbox.init();
    return {
      outbox,
      cleanup: async () => {
        // Drop the per-test schema so we leave the DB in a clean state.
        // Use a separate pool (the outbox's own may already be closed).
        try {
          // @ts-expect-error — pg is an optional peer dependency
          const pg = await import('pg');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Pool = (pg.Pool ?? (pg.default as any)?.Pool ?? pg) as any;
          const pool = new Pool({ connectionString: PG_URL });
          try {
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await pool.end();
          }
        } catch { /* ignore — best-effort */ }
        await outbox.close();
      },
    };
  });
} else {
  describe.skip('PostgresOutbox — parity', () => {
    it('skipped: AP3X_PG_URL not set', () => {});
  });
}
