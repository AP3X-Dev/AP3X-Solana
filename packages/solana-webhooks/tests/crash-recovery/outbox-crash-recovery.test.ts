// Outbox crash-recovery fuzz.
//
// Intent: simulate killing the receiver process at random points during
// webhook handling and verify that on restart every received event ends up
// exactly once at the signal-bus consumer (no losses, no duplicates after
// consumer-side dedup).
//
// Process forking from inside vitest is fragile (especially on Windows), so
// the fuzz models the relevant crash semantics in-process by attacking the
// most subtle seam: between a successful `emit` (consumer received the event)
// and the subsequent `outbox.markProcessed` call. A real process death there
// leaves the row in `pending` state; on restart the drainer reprocesses it
// and the consumer sees it twice. The contract under test is "consumer-side
// dedup on signature collapses the duplicate, so the bus sees exactly once."
//
// Other crash seams are mechanically simpler (durability boundary cleanly
// covers them):
//   - crash before outbox.insert → upstream retries → eventually inserted
//   - crash after insert, before 200 → upstream retries → second insert
//     idempotent via composite (source, id) primary key
//   - crash mid-normalize → existing drainer test covers (normalize error
//     path → markFailed → retry on next cycle)
//   - crash mid-emit (throw) → existing drainer test covers (emit error
//     path → markFailed → retry on next cycle)
//
// The post-emit-pre-mark seam is the at-least-once → exactly-once-via-dedup
// boundary the receiver guarantees. 100 iterations across that seam with
// random row counts and random crash-target rows.

import { describe, it, expect } from 'vitest';

import { SqliteOutbox } from '../../src/outbox/sqlite.js';
import type { Outbox, OutboxRow, PendingOptions } from '../../src/outbox/store.js';
import { Drainer } from '../../src/outbox/drainer.js';
import { createHeliusDriver, HELIUS_SOURCE } from '../../src/drivers/helius/receiver.js';
import type { WebhookDriver, WebhookEvent } from '../../src/types.js';
import type { HeliusEnhancedTx } from '../../src/drivers/helius/normalize.js';

let sqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('better-sqlite3');
} catch {
  sqliteAvailable = false;
}

// Deterministic per-iteration RNG so failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthSwapTx(seed: number, idx: number): HeliusEnhancedTx {
  // A SWAP that the normalizer classifies as `helius-swap`. Slot is unique
  // per (seed, idx) so the consumer can dedupe by signature alone.
  return {
    signature: `crash-fuzz-${seed}-${idx}`,
    slot: 1_000_000 + seed * 1000 + idx,
    type: 'SWAP',
    transactionError: null,
    feePayer: 'WALLET_FUZZ',
    tokenTransfers: [
      {
        fromUserAccount: 'WALLET_FUZZ',
        toUserAccount: 'POOL',
        mint: 'So11111111111111111111111111111111111111112',
        tokenAmount: 1.0,
      },
      {
        fromUserAccount: 'POOL',
        toUserAccount: 'WALLET_FUZZ',
        mint: 'TargetMintZZZ',
        tokenAmount: 1000,
      },
    ],
  };
}

/**
 * Wrap an outbox so `markProcessed` is dropped exactly once for the targeted
 * (source, id). All other calls pass through unmodified. The drop is silent —
 * caller's await resolves normally — modeling a process crash between the
 * consumer's success and the bookkeeping write hitting disk.
 */
function outboxWithDroppedMark(real: Outbox, targetSource: string, targetId: string): Outbox {
  let dropped = false;
  return {
    init: () => real.init(),
    insert: (e: WebhookEvent) => real.insert(e),
    pending: (opts: PendingOptions) => real.pending(opts),
    async markProcessed(source: string, id: string, processedAt: number): Promise<void> {
      if (!dropped && source === targetSource && id === targetId) {
        dropped = true;
        return; // simulate crash mid-bookkeeping
      }
      return real.markProcessed(source, id, processedAt);
    },
    markFailed: (s, i, err, attempts) => real.markFailed(s, i, err, attempts),
    close: () => real.close(),
  };
}

async function drainToCompletion(d: Drainer): Promise<void> {
  // Stops when a cycle does no work. The fuzz uses drainOnce() loops rather
  // than start()/stop() to keep timing deterministic.
  for (let i = 0; i < 50; i++) {
    const r = await d.drainOnce();
    if (r.processed === 0 && r.failed === 0) return;
  }
  throw new Error('drainToCompletion: did not converge in 50 cycles');
}

describe.skipIf(!sqliteAvailable)('outbox crash-recovery fuzz (post-emit-pre-mark seam)', () => {
  it('100 random crashes converge on exactly-once at the deduped consumer', async () => {
    const ITERATIONS = 100;
    const driver: WebhookDriver = createHeliusDriver({ secret: 'fuzz-secret' });

    for (let seed = 0; seed < ITERATIONS; seed++) {
      const rng = mulberry32(seed);
      const N = 3 + Math.floor(rng() * 12); // 3..14 rows per iteration
      const txs = Array.from({ length: N }, (_, i) => synthSwapTx(seed, i));

      // Fresh in-memory sqlite per iteration so prior state doesn't leak.
      const real = new SqliteOutbox({ path: ':memory:' });
      await real.init();

      // Pre-stage: receiver successfully accepted N rows.
      const baseTime = Date.now();
      for (let i = 0; i < N; i++) {
        const tx = txs[i]!;
        const ok = await real.insert({
          source: HELIUS_SOURCE,
          id: `helius:${tx.signature}`,
          rawPayload: new TextEncoder().encode(JSON.stringify(tx)),
          receivedAt: baseTime + i,
        });
        expect(ok, `iteration ${seed}: insert ${i} should be new`).toBe(true);
      }

      // Pick a random row whose markProcessed will be dropped (the "crash").
      const crashIdx = Math.floor(rng() * N);
      const crashId = `helius:${txs[crashIdx]!.signature}`;

      // Consumer with signature dedup. Records every distinct signature seen.
      // Also records the duplicate count so we can prove dedup actually
      // collapsed the at-least-once delivery.
      const seen = new Set<string>();
      const totalEmits = { count: 0 };
      const emit = async (event: { signature: string }): Promise<void> => {
        totalEmits.count += 1;
        seen.add(event.signature);
      };

      // ----- Phase 1: drain with the crash-at-bookkeeping outbox wrapper.
      const crashedOutbox = outboxWithDroppedMark(real, HELIUS_SOURCE, crashId);
      const d1 = new Drainer({
        outbox: crashedOutbox,
        drivers: { [HELIUS_SOURCE]: driver },
        emit: emit as never,
      });
      await drainToCompletion(d1);

      // ----- Phase 2: restart with the real outbox. The dropped row is
      // still in `pending` state, so the drainer reprocesses it.
      const d2 = new Drainer({
        outbox: real,
        drivers: { [HELIUS_SOURCE]: driver },
        emit: emit as never,
        retryDelayMs: 0, // immediate retry — no clock games
      });
      await drainToCompletion(d2);

      // ----- Assertions ---------------------------------------------------

      // No event lost: every signature reached the deduped consumer.
      for (const tx of txs) {
        expect(seen.has(tx.signature), `iteration ${seed}: lost ${tx.signature}`).toBe(true);
      }

      // The crashed row was emitted at least twice (once before the dropped
      // mark, once on restart), proving the at-least-once seam was actually
      // exercised. Total emits must be N+1 (or more if multiple seams fire,
      // though our wrapper only drops one mark per iteration).
      expect(
        totalEmits.count,
        `iteration ${seed}: expected ≥${N + 1} emits (crash duplicates row ${crashIdx}), got ${totalEmits.count}`,
      ).toBeGreaterThanOrEqual(N + 1);

      // Outbox is fully drained — every row reached the `processed` terminal
      // state. This is the durability invariant: no pending rows after the
      // recovery cycle finishes.
      const stillPending = await real.pending({ limit: 10000, maxAttempts: 999, retryDelayMs: 0 });
      expect(
        stillPending.length,
        `iteration ${seed}: ${stillPending.length} pending row(s) remained after recovery`,
      ).toBe(0);

      await real.close();
    }
  }, 30_000);
});
