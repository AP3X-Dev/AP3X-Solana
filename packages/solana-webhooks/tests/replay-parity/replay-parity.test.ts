// Replay-parity gate for the Helius driver.
//
// Runs the Python reference parser (`gmgn_tracker.helius.parser.parse_buy`)
// against the captured fixtures and compares its output to the TypeScript
// `classifyHeliusBuy` projection. Asserts ≥95% byte-for-byte parity on the
// BUY-classification surface across all fixtures.
//
// The reference parser is kept out-of-tree on purpose: it's the source of
// truth, so we shell out to the Python rather than re-implementing it inside
// the TS test. If Python or the tracker package isn't installed locally, the
// suite self-skips so this developer's CI matrix isn't constrained by the
// runtime layout of every contributor's machine.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeHeliusTx, type HeliusEnhancedTx } from '../../src/drivers/helius/normalize.js';
import { classifyHeliusBuy, type BuyProjection } from './classifyBuy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures', 'helius');
const HELPER = join(HERE, 'parity_helper.py');

const PYTHON = process.env.AP3X_PYTHON ?? process.env.PYTHON ?? 'python';
const TRACKED_WALLET = 'WALLET_ADDR';

// Captured fixtures — same set the Python `test_helius_parser.py` exercises.
// Expected classification reflects the Python reference, not the substrate
// driver (which is wallet-agnostic).
type ExpectedClass = 'buy' | 'non-buy';
const FIXTURES: ReadonlyArray<{ name: string; expected: ExpectedClass }> = [
  { name: 'swap_buy.json',             expected: 'buy' },
  { name: 'jupiter_swap.json',         expected: 'buy' },
  { name: 'pumpfun_buy.json',          expected: 'buy' },
  { name: 'buy_with_dust_rebate.json', expected: 'buy' },
  { name: 'token_mint_buy.json',       expected: 'buy' },
  { name: 'sell.json',                 expected: 'non-buy' },
  { name: 'transfer.json',             expected: 'non-buy' },
  { name: 'failed.json',               expected: 'non-buy' },
];

const PARITY_THRESHOLD = 0.95;

function pythonAvailable(): boolean {
  const probe = spawnSync(
    PYTHON,
    ['-c', 'import gmgn_tracker.helius.parser'],
    { encoding: 'utf8' },
  );
  return probe.status === 0;
}

function runReferenceParser(fixturePath: string, wallet: string): BuyProjection | null {
  const result = spawnSync(
    PYTHON,
    [HELPER, fixturePath, wallet],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `parity_helper.py exited ${result.status} for ${fixturePath}: ${result.stderr}`,
    );
  }
  const trimmed = result.stdout.trim();
  if (trimmed === 'null') return null;
  return JSON.parse(trimmed) as BuyProjection;
}

function loadFixture(name: string): HeliusEnhancedTx {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as HeliusEnhancedTx;
}

interface CellResult {
  fixture: string;
  field: string;
  pythonValue: unknown;
  tsValue: unknown;
  match: boolean;
}

function compareBuy(
  fixture: string,
  py: BuyProjection,
  ts: BuyProjection,
): CellResult[] {
  // wallet_address is the same input on both sides — exclude from parity calc.
  const fields: ReadonlyArray<keyof BuyProjection> = [
    'signature', 'token_mint', 'sol_amount', 'token_amount', 'block_time_unix',
  ];
  return fields.map((field) => ({
    fixture,
    field,
    pythonValue: py[field],
    tsValue: ts[field],
    match: py[field] === ts[field],
  }));
}

const skip = !pythonAvailable();

describe.skipIf(skip)('Helius replay parity (Python reference vs TS classifier)', () => {
  it('TS BUY classifier reproduces the Python reference at ≥95% field parity', () => {
    const cells: CellResult[] = [];
    const classMismatches: string[] = [];

    for (const { name, expected } of FIXTURES) {
      const fixturePath = join(FIXTURES_DIR, name);
      const tx = loadFixture(name);

      const py = runReferenceParser(fixturePath, TRACKED_WALLET);
      const ts = classifyHeliusBuy(tx, TRACKED_WALLET);

      // Sanity-check the fixture set against its declared expectation.
      if (expected === 'buy') {
        expect(py, `${name}: Python reference should return Buy`).not.toBeNull();
      } else {
        expect(py, `${name}: Python reference should return null`).toBeNull();
      }

      // Cell #1 per fixture: classification agreement.
      const classCell: CellResult = {
        fixture: name,
        field: 'classification',
        pythonValue: py === null ? 'null' : 'buy',
        tsValue: ts === null ? 'null' : 'buy',
        match: (py === null) === (ts === null),
      };
      cells.push(classCell);
      if (!classCell.match) classMismatches.push(name);

      // Cells 2..6: only when both sides classified as BUY.
      if (py !== null && ts !== null) {
        cells.push(...compareBuy(name, py, ts));
      }

      // The driver-level normalizer must also surface SOMETHING for every
      // fixture (substrate rule: never silently drop). Sanity-check.
      const events = normalizeHeliusTx(tx);
      expect(events.length, `${name}: normalizer should emit ≥1 event`).toBeGreaterThan(0);
    }

    const total = cells.length;
    const matches = cells.filter((c) => c.match).length;
    const parity = total === 0 ? 0 : matches / total;

    const mismatches = cells.filter((c) => !c.match);
    const report = mismatches
      .map((c) => `  ${c.fixture}.${c.field}: py=${JSON.stringify(c.pythonValue)} ts=${JSON.stringify(c.tsValue)}`)
      .join('\n');

    expect(
      parity,
      `parity ${(parity * 100).toFixed(2)}% < ${(PARITY_THRESHOLD * 100).toFixed(0)}% threshold (${matches}/${total} cells matched)\nMismatches:\n${report || '  (none)'}`,
    ).toBeGreaterThanOrEqual(PARITY_THRESHOLD);

    // Classification disagreement is the strongest parity signal — even one
    // mismatch is worth surfacing as a hard failure, since the rest of the
    // BUY surface is meaningless if the two parsers don't agree on whether
    // it's a buy at all.
    expect(
      classMismatches,
      `classification disagreement on: ${classMismatches.join(', ')}`,
    ).toEqual([]);
  });
});

describe.skipIf(!skip)('Helius replay parity', () => {
  it.skip(
    'self-skipped: Python `gmgn_tracker.helius.parser` not importable on this host. ' +
    `Set AP3X_PYTHON to a Python with the tracker package installed (probed: \`${PYTHON}\`).`,
    () => undefined,
  );
});
