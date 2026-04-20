/**
 * e2e test for pumpfun-watch CLI.
 *
 * Runs `node dist/index.js --source fixture` against the bundled fixture and
 * verifies that one JSON line is emitted per signal with the expected shape.
 *
 * Build dependency: turbo.json `test` task has `dependsOn: ["^build"]`, which
 * builds workspace dependencies but NOT the package's own dist. To ensure a
 * fresh dist exists we build it in `beforeAll` (skipped if dist is newer than
 * src/index.ts). This keeps the test reliable both in CI (Turbo pre-builds)
 * and locally (`pnpm --filter @ap3x/pumpfun-watch test`).
 *
 * Fastest local workflow:
 *   pnpm --filter @ap3x/pumpfun-watch build && pnpm --filter @ap3x/pumpfun-watch test
 * Or rely on Turbo's full pipeline:
 *   pnpm test (from monorepo root)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUMPFUN_BONDING_CURVE_PROGRAM_ID,
  PUMPFUN_PUMPSWAP_PROGRAM_ID,
} from '@ap3x/pumpfun-events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_DIR = path.resolve(__dirname, '..');
const DIST_INDEX = path.resolve(PACKAGE_DIR, 'dist', 'index.js');
const SRC_INDEX = path.resolve(PACKAGE_DIR, 'src', 'index.ts');
const FIXTURE_PATH = path.resolve(PACKAGE_DIR, 'tests', 'fixtures', 'signals-pumpfun-watch.jsonl.gz');

const BC_PROGRAM = PUMPFUN_BONDING_CURVE_PROGRAM_ID.toBase58();
const PS_PROGRAM = PUMPFUN_PUMPSWAP_PROGRAM_ID.toBase58();

const EXPECTED_TOTAL = 20;
const EXPECTED_KINDS = new Set([
  'pumpfun.create',
  'pumpfun.trade',
  'pumpfun.complete',
  'pumpfun.set_params',
  'pumpfun.creator_fee',
  'pumpfun.migrate',
  'pumpfun.swap',
  'pumpfun.add_liquidity',
  'pumpfun.remove_liquidity',
  'pumpfun.admin_set_params',
  'unknown',
]);

/**
 * Returns true if `dist/index.js` exists and is newer than `src/index.ts`.
 * When true, we can skip the build step (optimisation for repeated local runs).
 */
function distIsUpToDate(): boolean {
  if (!existsSync(DIST_INDEX)) return false;
  try {
    const distMtime = statSync(DIST_INDEX).mtimeMs;
    const srcMtime = statSync(SRC_INDEX).mtimeMs;
    return distMtime >= srcMtime;
  } catch {
    return false;
  }
}

beforeAll(() => {
  if (distIsUpToDate()) return;
  execSync('pnpm --filter @ap3x/pumpfun-watch build', {
    cwd: path.resolve(PACKAGE_DIR, '../..'),
    stdio: 'inherit',
    encoding: 'utf8',
  });
}, /* timeout */ 120_000);

describe('pumpfun-watch e2e', () => {
  it('emits one JSON line per signal in the bundled fixture (default --fixture-path)', () => {
    const out = execSync(
      `node "${DIST_INDEX}" --source fixture --fixture-path "${FIXTURE_PATH}"`,
      { encoding: 'utf8' },
    );

    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(EXPECTED_TOTAL);

    const kindsSeen = new Set<string>();
    const programIdsSeen = new Set<string>();
    for (const line of lines) {
      const j = JSON.parse(line) as Record<string, unknown>;
      expect(typeof j['signalId']).toBe('string');
      expect(typeof j['signature']).toBe('string');
      expect(typeof j['slot']).toBe('number');
      expect(typeof j['ts']).toBe('number');
      expect(typeof j['kind']).toBe('string');
      expect(typeof j['programId']).toBe('string');
      expect(j['decoded']).toBeTypeOf('object');

      kindsSeen.add(j['kind'] as string);
      programIdsSeen.add(j['programId'] as string);
    }

    // Every expected kind appears at least once.
    for (const k of EXPECTED_KINDS) {
      expect(kindsSeen.has(k)).toBe(true);
    }

    // Both pump.fun programs are represented.
    expect(programIdsSeen.has(BC_PROGRAM)).toBe(true);
    expect(programIdsSeen.has(PS_PROGRAM)).toBe(true);
  });

  it('respects --max-events cap', () => {
    const out = execSync(
      `node "${DIST_INDEX}" --source fixture --fixture-path "${FIXTURE_PATH}" --max-events 5`,
      { encoding: 'utf8' },
    );
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(5);
  });

  it('uses the bundled fixture when --fixture-path is omitted', () => {
    // The bundled fixture is resolved relative to dist/index.js, which lives
    // alongside tests/ under the package directory — so running from any cwd
    // should still find it.
    const out = execSync(
      `node "${DIST_INDEX}" --source fixture`,
      { encoding: 'utf8', cwd: PACKAGE_DIR },
    );
    const lines = out.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(EXPECTED_TOTAL);
  });

  it('fails fast when --source is missing', () => {
    expect(() => {
      execSync(`node "${DIST_INDEX}"`, { encoding: 'utf8' });
    }).toThrow();
  });
});
