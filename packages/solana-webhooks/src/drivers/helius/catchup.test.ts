import { describe, it, expect } from 'vitest';
import type { TypedSolanaEvent } from '../../types.js';
import { HeliusCatchup } from './catchup.js';
import type { HeliusEnhancedTx } from './normalize.js';

// ---------------------------------------------------------------------------
// Fake fetch — yields canned pages keyed by `before` cursor.
// ---------------------------------------------------------------------------

interface FakeFetchPages {
  /** First page (no `before` query param). */
  initial: HeliusEnhancedTx[];
  /** Subsequent pages keyed by the `before` cursor passed in the URL. */
  byCursor?: Record<string, HeliusEnhancedTx[]>;
}

function fakeFetch(pages: FakeFetchPages): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const before = url.searchParams.get('before');
    const txs = before
      ? (pages.byCursor?.[before] ?? [])
      : pages.initial;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() { return txs; },
    } as Response;
  }) as typeof fetch;
}

function tx(opts: { signature: string; slot: number; type?: string }): HeliusEnhancedTx {
  return {
    signature: opts.signature,
    slot: opts.slot,
    type: opts.type ?? 'TRANSFER',
    transactionError: null,
    tokenTransfers: [],
    nativeTransfers: [],
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HeliusCatchup', () => {
  it('emits one TypedSolanaEvent per Helius tx in the initial page', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      fetch: fakeFetch({
        initial: [
          tx({ signature: 's1', slot: 100 }),
          tx({ signature: 's2', slot: 99 }),
          tx({ signature: 's3', slot: 98 }),
        ],
      }),
    });

    const events = await collect(c.fetchRange({ address: 'addr' }));
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.signature)).toEqual(['s1', 's2', 's3']);
  });

  it('pages via the `before` cursor until empty', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      fetch: fakeFetch({
        initial: [
          tx({ signature: 's1', slot: 100 }),
          tx({ signature: 's2', slot: 99 }),
        ],
        byCursor: {
          's2': [
            tx({ signature: 's3', slot: 98 }),
            tx({ signature: 's4', slot: 97 }),
          ],
          's4': [],
        },
      }),
    });

    const events = await collect(c.fetchRange({ address: 'addr' }));
    expect(events.map((e) => e.signature)).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('stops paging when slot drops below fromSlot', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      fetch: fakeFetch({
        initial: [
          tx({ signature: 's1', slot: 100 }),
          tx({ signature: 's2', slot: 95 }),
          tx({ signature: 's3', slot: 80 }), // below fromSlot — stop
        ],
        byCursor: {
          's3': [tx({ signature: 's4', slot: 50 })], // never reached
        },
      }),
    });

    const events = await collect(c.fetchRange({ address: 'addr', fromSlot: 90 }));
    expect(events.map((e) => e.signature)).toEqual(['s1', 's2']);
  });

  it('skips transactions newer than toSlot', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      fetch: fakeFetch({
        initial: [
          tx({ signature: 's1', slot: 100 }), // above toSlot — skip
          tx({ signature: 's2', slot: 95 }),
          tx({ signature: 's3', slot: 90 }),
        ],
      }),
    });

    const events = await collect(c.fetchRange({ address: 'addr', toSlot: 95 }));
    expect(events.map((e) => e.signature)).toEqual(['s2', 's3']);
  });

  it('respects the limit cap on total events emitted', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      fetch: fakeFetch({
        initial: Array.from({ length: 10 }, (_, i) => tx({ signature: `s${i}`, slot: 100 - i })),
      }),
    });

    const events = await collect(c.fetchRange({ address: 'addr', limit: 4 }));
    expect(events).toHaveLength(4);
  });

  it('respects maxPages', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      maxPages: 1,
      fetch: fakeFetch({
        initial: [tx({ signature: 's1', slot: 100 }), tx({ signature: 's2', slot: 99 })],
        byCursor: {
          's2': [tx({ signature: 's3', slot: 98 })],
        },
      }),
    });

    const events = await collect(c.fetchRange({ address: 'addr' }));
    expect(events.map((e) => e.signature)).toEqual(['s1', 's2']);
  });

  it('throws on non-OK API responses', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      fetch: (async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        async json() { return {}; },
      })) as never,
    });

    await expect(collect(c.fetchRange({ address: 'addr' }))).rejects.toThrow(/401/);
  });

  it('throws on malformed (non-array) body', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      fetch: (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() { return { error: 'oops' }; },
      })) as never,
    });

    await expect(collect(c.fetchRange({ address: 'addr' }))).rejects.toThrow(/non-array/);
  });

  it('passes through TypedSolanaEvent shape from normalizeHeliusTx', async () => {
    const c = new HeliusCatchup({
      apiKey: 'k',
      fetch: fakeFetch({
        initial: [
          tx({ signature: 'failed-sig', slot: 100, type: 'SWAP' }),
        ],
      }),
    });

    const events = await collect(c.fetchRange({ address: 'addr' }));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('decoded'); // SWAP with no transactionError
    expect((events[0] as TypedSolanaEvent).slot).toBe(100);
  });
});
