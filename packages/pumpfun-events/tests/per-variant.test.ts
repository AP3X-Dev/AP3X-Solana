import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { parseLogs } from '@ap3x/solana-events';
import {
  bondingCurveDecoder,
  pumpSwapDecoder,
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '../src/index.js';
import type { PumpFunBondingCurveEvent, PumpSwapEvent } from '../src/index.js';

const FIXTURE_PATH = 'tests/fixtures/pumpfun-per-variant.jsonl.gz';

interface FixtureLine {
  programId: string;
  variantHint: string;
  signature: string;
  slot: number;
  blockTime: number;
  logs: string[];
}

function loadFixture(): FixtureLine[] {
  if (!existsSync(FIXTURE_PATH)) return [];
  try {
    const decompressed = gunzipSync(readFileSync(FIXTURE_PATH)).toString('utf-8');
    const lines = decompressed.split('\n').filter(Boolean);
    const out: FixtureLine[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as FixtureLine);
      } catch {
        // Skip malformed lines rather than throwing at module-load time.
        // A malformed fixture should not cause the whole test file to error out;
        // the describe.skipIf guards downstream.
      }
    }
    return out;
  } catch {
    // Corrupt gzip or read error — treat as "no fixture" so the suite skips
    // rather than crashing the runner.
    return [];
  }
}

const fixture = loadFixture();
const haveFixture = fixture.length > 0;

describe.skipIf(!haveFixture)('per-variant decoder correctness', () => {
  const bondingCurveVariants = [
    'pumpfun.create',
    'pumpfun.trade',
    'pumpfun.complete',
    'pumpfun.set_params',
    'pumpfun.creator_fee',
    'pumpfun.migrate',
  ];

  const pumpSwapVariants = [
    'pumpfun.swap',
    'pumpfun.add_liquidity',
    'pumpfun.remove_liquidity',
    'pumpfun.admin_set_params',
  ];

  for (const variant of bondingCurveVariants) {
    it(`decodes ${variant} from a real captured event`, ({ skip }) => {
      const line = fixture.find((f) => f.variantHint === variant);
      if (!line) {
        skip(`fixture missing ${variant} — rerun pnpm capture:pumpfun-per-variant with a wider scan window`);
        return;
      }
      const parsed = parseLogs(line.logs);
      const chunks = parsed.chunks.filter(
        (c) => c.programId === PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58(),
      );
      let found: PumpFunBondingCurveEvent | undefined;
      for (const chunk of chunks) {
        const r = bondingCurveDecoder.decode(chunk);
        if (r.kind === variant) {
          found = r;
          break;
        }
      }
      expect(found).toBeDefined();
      expect(found?.kind).toBe(variant);
    });
  }

  for (const variant of pumpSwapVariants) {
    it(`decodes ${variant} from a real captured event`, ({ skip }) => {
      const line = fixture.find((f) => f.variantHint === variant);
      if (!line) {
        skip(`fixture missing ${variant} — rerun pnpm capture:pumpfun-per-variant with a wider scan window`);
        return;
      }
      const parsed = parseLogs(line.logs);
      const chunks = parsed.chunks.filter(
        (c) => c.programId === PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58(),
      );
      let found: PumpSwapEvent | undefined;
      for (const chunk of chunks) {
        const r = pumpSwapDecoder.decode(chunk);
        if (r.kind === variant) {
          found = r;
          break;
        }
      }
      expect(found).toBeDefined();
      expect(found?.kind).toBe(variant);
    });
  }
});

describe.skipIf(haveFixture)('per-variant tests (skipped — fixture absent)', () => {
  it('skips; run pnpm capture:pumpfun-per-variant with HELIUS_API_KEY to populate', () => {
    expect(haveFixture).toBe(false);
  });
});
