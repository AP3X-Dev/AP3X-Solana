// Catchup synthetic — live/pause/resume gap recovery.
//
// Models the live-pause-resume scenario: a webhook stream is delivering
// live, then delivery stops for some interval (driver outage, upstream
// maintenance, our process down), then live resumes. The chain activity
// that happened during the pause is the "gap"; catchup must recover it
// via the REST enhanced-tx API and surface the gap signatures tagged with
// `source: 'catchup'` so downstream consumers can distinguish recovered
// events from live ones.
//
// This test composes the live-state and catchup paths in a single scenario,
// distinct from the unit tests in `src/drivers/helius/catchup.test.ts` which
// exercise paging mechanics in isolation.

import { describe, it, expect } from 'vitest';

import { HeliusCatchup } from '../../src/drivers/helius/catchup.js';
import type { HeliusEnhancedTx } from '../../src/drivers/helius/normalize.js';
import type { TypedSolanaEvent } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Scenario: a tracked address sees seven swaps across slots 100..106.
//   - Slots 100, 101 → live webhooks delivered (sig-A, sig-B)
//   - Slots 102, 103, 104 → PAUSE — webhooks not delivered (sig-C, sig-D, sig-E)
//   - Slots 105, 106 → live webhooks resumed (sig-F, sig-G)
//
// On resume, the integrator triggers `catchup({ fromSlot: 102, toSlot: 104 })`
// to fill the gap. The contract under test:
//   1. catchup yields exactly the gap signatures, in any order
//   2. catchup yields nothing outside the gap window — early pages from the
//      newest-first API include sig-G/sig-F/sig-E... but slot bounds clamp
//      the window correctly
//   3. wrapping the catchup output with `source: 'catchup'` produces a
//      consumer-visible stream where only gap signatures bear that tag
// ---------------------------------------------------------------------------

function tx(opts: { signature: string; slot: number }): HeliusEnhancedTx {
  return {
    signature: opts.signature,
    slot: opts.slot,
    type: 'TRANSFER',
    transactionError: null,
    feePayer: 'WALLET_TRACKED',
    tokenTransfers: [],
    nativeTransfers: [],
  };
}

// API returns newest-first. The whole-history page mirrors what an integrator
// would observe if they called the enhanced-tx API for this address with no
// cursor.
const HISTORY: HeliusEnhancedTx[] = [
  tx({ signature: 'sig-G', slot: 106 }),
  tx({ signature: 'sig-F', slot: 105 }),
  tx({ signature: 'sig-E', slot: 104 }),
  tx({ signature: 'sig-D', slot: 103 }),
  tx({ signature: 'sig-C', slot: 102 }),
  tx({ signature: 'sig-B', slot: 101 }),
  tx({ signature: 'sig-A', slot: 100 }),
];

// What the receiver actually saw via live webhooks (pause swallowed slots
// 102..104).
const LIVE_DELIVERED = new Set<string>(['sig-A', 'sig-B', 'sig-F', 'sig-G']);
// The gap the catchup call must fill.
const GAP_EXPECTED = new Set<string>(['sig-C', 'sig-D', 'sig-E']);

function mockApi(txs: HeliusEnhancedTx[]): typeof fetch {
  // Single page since the scenario is small. The catchup paginator stops
  // when an empty page comes back; we return the empty-page sentinel on
  // any cursor lookup.
  return (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const before = url.searchParams.get('before');
    const body = before ? [] : txs;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() { return body; },
    } as Response;
  }) as typeof fetch;
}

interface TaggedEvent {
  source: 'live' | 'catchup';
  signature: string;
}

function eventSignature(e: TypedSolanaEvent): string {
  return e.signature;
}

describe('catchup synthetic — pause/resume gap recovery', () => {
  it('catchup yields exactly the gap signatures and nothing outside the slot window', async () => {
    const catchup = new HeliusCatchup({
      apiKey: 'test',
      baseUrl: 'http://mock',
      fetch: mockApi(HISTORY),
      pageSize: 100,
    });

    const yielded: TypedSolanaEvent[] = [];
    for await (const ev of catchup.fetchRange({
      address: 'WALLET_TRACKED',
      fromSlot: 102,
      toSlot: 104,
    })) {
      yielded.push(ev);
    }

    const yieldedSigs = new Set(yielded.map(eventSignature));
    expect(yieldedSigs).toEqual(GAP_EXPECTED);

    // Nothing outside the gap leaks through.
    expect(yieldedSigs.has('sig-A')).toBe(false);
    expect(yieldedSigs.has('sig-B')).toBe(false);
    expect(yieldedSigs.has('sig-F')).toBe(false);
    expect(yieldedSigs.has('sig-G')).toBe(false);
  });

  it('integrating catchup with a live consumer tags only gap events as source: catchup', async () => {
    // The live-side has already populated the consumer with what the receiver
    // saw via webhooks. Catchup events are tagged differently so consumers
    // (a downstream signal bus, an audit log) can distinguish recovered
    // events from real-time ones.
    const consumer: TaggedEvent[] = [];
    for (const sig of LIVE_DELIVERED) {
      consumer.push({ source: 'live', signature: sig });
    }

    const catchup = new HeliusCatchup({
      apiKey: 'test',
      baseUrl: 'http://mock',
      fetch: mockApi(HISTORY),
      pageSize: 100,
    });

    for await (const ev of catchup.fetchRange({
      address: 'WALLET_TRACKED',
      fromSlot: 102,
      toSlot: 104,
    })) {
      consumer.push({ source: 'catchup', signature: ev.signature });
    }

    // Every chain signature reached the consumer.
    const allSigs = new Set(consumer.map((c) => c.signature));
    expect(allSigs).toEqual(new Set(['sig-A', 'sig-B', 'sig-C', 'sig-D', 'sig-E', 'sig-F', 'sig-G']));

    // Only gap signatures bear `source: 'catchup'`; live signatures bear
    // `source: 'live'`. The downstream bus uses this to gate metrics, audit,
    // alert-fires (alerts on catchup events are typically suppressed since
    // they're historical).
    const catchupSigs = new Set(consumer.filter((c) => c.source === 'catchup').map((c) => c.signature));
    const liveSigs = new Set(consumer.filter((c) => c.source === 'live').map((c) => c.signature));

    expect(catchupSigs).toEqual(GAP_EXPECTED);
    expect(liveSigs).toEqual(LIVE_DELIVERED);

    // No signature is double-tagged. The gap and the live set are disjoint
    // in this scenario by construction; if a future change introduces
    // overlap (live happens to deliver during catchup), consumers must
    // dedupe on signature anyway. Document the disjoint expectation here
    // so the test fails fast if anyone breaks the scenario.
    for (const sig of catchupSigs) {
      expect(liveSigs.has(sig), `${sig} appears in both live and catchup`).toBe(false);
    }
  });
});
