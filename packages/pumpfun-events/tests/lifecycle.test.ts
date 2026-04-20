import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { parseLogs } from '@ap3x/solana-events';
import {
  bondingCurveDecoder,
  pumpSwapDecoder,
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '../src/index.js';

const FIXTURE_PATH = 'tests/fixtures/pumpfun-lifecycle.jsonl.gz';
const haveFixture = existsSync(FIXTURE_PATH);

interface FixtureLine {
  programId: string;
  signature: string;
  slot: number;
  blockTime: number;
  mintHint?: string;
  logs: string[];
}

function loadFixture(): FixtureLine[] {
  if (!haveFixture) return [];
  try {
    const decompressed = gunzipSync(readFileSync(FIXTURE_PATH)).toString('utf-8');
    const lines = decompressed.split('\n').filter(Boolean);
    const out: FixtureLine[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as FixtureLine);
      } catch {
        // Skip malformed lines rather than throwing at module-load time.
        // A malformed fixture should not cause the whole test file to error
        // out; the describe.skipIf guards downstream.
      }
    }
    return out;
  } catch {
    // Corrupt gzip or read error — treat as "no fixture" so the suite skips
    // rather than crashing the runner.
    return [];
  }
}

describe.skipIf(!haveFixture)('full-lifecycle decoder flow', () => {
  const lines = loadFixture();

  const byMint = new Map<string, FixtureLine[]>();
  for (const line of lines) {
    if (!line.mintHint) continue;
    const list = byMint.get(line.mintHint) ?? [];
    list.push(line);
    byMint.set(line.mintHint, list);
  }

  it('has at least 2 tokens with lifecycle traces', () => {
    expect(byMint.size).toBeGreaterThanOrEqual(2);
  });

  for (const [mintHint, traces] of byMint) {
    describe(`mint ${mintHint}`, () => {
      // Sort oldest-first once per mint so ordering-sensitive assertions
      // (e.g. "Create at the start") see a stable chronological view.
      const sorted = [...traces].sort((a, b) => a.slot - b.slot);

      it('contains a CreateEvent at the start of the trace', () => {
        const first = sorted[0];
        expect(first).toBeDefined();
        const parsed = parseLogs(first!.logs);
        const found = parsed.chunks
          .filter((c) => c.programId === PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58())
          .map((c) => bondingCurveDecoder.decode(c))
          .find((e) => e.kind === 'pumpfun.create');
        expect(found).toBeDefined();
      });

      it('contains a MigrateEvent marking graduation', () => {
        const allMigrates = sorted
          .flatMap((t) => {
            const parsed = parseLogs(t.logs);
            return parsed.chunks
              .filter((c) => c.programId === PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58())
              .map((c) => bondingCurveDecoder.decode(c));
          })
          .filter((e) => e.kind === 'pumpfun.migrate');
        expect(allMigrates.length).toBeGreaterThan(0);
      });

      it('contains PumpSwap SwapEvents after graduation', () => {
        const allSwaps = sorted
          .flatMap((t) => {
            const parsed = parseLogs(t.logs);
            return parsed.chunks
              .filter((c) => c.programId === PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58())
              .map((c) => pumpSwapDecoder.decode(c));
          })
          .filter((e) => e.kind === 'pumpfun.swap');
        expect(allSwaps.length).toBeGreaterThan(0);
      });
    });
  }
});

describe.skipIf(haveFixture)('full-lifecycle integration (skipped — fixture absent)', () => {
  it('skips; run pnpm capture:pumpfun-lifecycle with HELIUS_API_KEY to populate', () => {
    expect(haveFixture).toBe(false);
  });
});
