// Carbon oracle comparison (ap3x-engine PRP §11).
//
// Decodes the same fixtures with the TypeScript decoders (@ap3x/pumpfun-events)
// and with Carbon (the Rust harness here), then compares every event field by
// field. Exits 1 on any disagreement in a field both decoders know: that is
// the early warning for a program upgrade the vendored IDLs have not caught.
// Fields only one side knows are reported as schema drift, not failures.
//
//   pnpm --filter @ap3x/pumpfun-events build
//   cargo build --release --manifest-path tools/carbon-oracle/Cargo.toml
//   node tools/carbon-oracle/compare.mjs packages/pumpfun-events/tests/fixtures/*.jsonl.gz

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const { decodeIdlEvent, PUMP_SCHEMA, PUMP_AMM_SCHEMA } = await import(pathToFileURL(resolve(here, '../../packages/pumpfun-events/dist/index.js')).href);

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const fixtures = process.argv.slice(2);
if (fixtures.length === 0) {
  console.error('usage: node compare.mjs <fixture.jsonl.gz>...');
  process.exit(2);
}

/** Same attribution as the Rust harness: each `Program data:` line belongs to the innermost invoking program. */
function payloads(logs) {
  const stack = [];
  const out = [];
  for (const l of logs) {
    if (!l.startsWith('Program ')) continue;
    const rest = l.slice(8);
    if (rest.startsWith('data: ')) {
      const bytes = Buffer.concat(rest.slice(6).split(' ').map((p) => Buffer.from(p, 'base64')));
      const top = stack.at(-1);
      if (top === PUMP || top === PUMPSWAP) out.push([top, bytes]);
      continue;
    }
    const [id, ...tail] = rest.split(' ');
    const t = tail.join(' ');
    if (t.startsWith('invoke [')) stack.push(id);
    else if (t === 'success' || t.startsWith('failed')) stack.pop();
  }
  return out;
}

/** The TS decoder's view in the harness's shape: snake_case keys, base58 keys, string numbers. */
function normalize(v) {
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  if (v === undefined) return null;
  if (v && typeof v === 'object' && typeof v.toBase58 === 'function') return v.toBase58();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), normalize(x)]));
  return v;
}

const carbonBin = resolve(here, 'target/release/carbon-oracle' + (process.platform === 'win32' ? '.exe' : ''));
const carbon = execFileSync(carbonBin, fixtures, { maxBuffer: 1 << 30 })
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const byKey = new Map(carbon.map((r) => [`${r.signature}:${r.program}:${r.index}`, r]));

let events = 0;
let failures = 0;
const drift = new Map();
const coverage = new Map();
for (const file of fixtures) {
  for (const line of gunzipSync(readFileSync(file)).toString().split('\n').filter(Boolean)) {
    const tx = JSON.parse(line);
    payloads(tx.logs ?? []).forEach(([program, bytes], index) => {
      events++;
      const key = `${tx.signature}:${program}:${index}`;
      const c = byKey.get(key);
      let ts = null;
      try {
        ts = decodeIdlEvent(program === PUMP ? PUMP_SCHEMA : PUMP_AMM_SCHEMA, bytes);
      } catch (e) {
        ts = { name: null, error: e.message };
      }
      const name = ts?.name ?? null;
      coverage.set(name ?? '(undecoded)', (coverage.get(name ?? '(undecoded)') ?? 0) + 1);
      if (!c || (c.event ?? null) !== name) {
        failures++;
        console.log(`MISMATCH ${key}: TypeScript decodes ${name ?? 'nothing'}, Carbon ${c?.event ?? 'nothing'}`);
        return;
      }
      if (!name) return;
      const t = normalize(ts.fields);
      for (const f of new Set([...Object.keys(t), ...Object.keys(c.fields)])) {
        const inTs = f in t;
        const inCarbon = f in c.fields;
        if (inTs && inCarbon) {
          if (JSON.stringify(t[f]) !== JSON.stringify(c.fields[f])) {
            failures++;
            console.log(`MISMATCH ${key} ${name}.${f}: TypeScript ${JSON.stringify(t[f])} vs Carbon ${JSON.stringify(c.fields[f])}`);
          }
        } else {
          const d = `${name}.${f} only in ${inTs ? 'TypeScript (vendored IDL newer than Carbon)' : 'Carbon'}`;
          drift.set(d, (drift.get(d) ?? 0) + 1);
        }
      }
    });
  }
}

console.log(`\n${events} events compared; ${failures} disagreement(s).`);
console.log(`coverage: ${[...coverage].map(([k, n]) => `${k}×${n}`).join(', ')}`);
if (drift.size) console.log(`schema drift (not a failure):\n${[...drift].map(([d, n]) => `  ${d} (${n})`).join('\n')}`);
process.exit(failures === 0 ? 0 : 1);
