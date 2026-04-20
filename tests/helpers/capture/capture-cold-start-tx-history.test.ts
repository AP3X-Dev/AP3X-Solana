import { describe, it, expect } from 'vitest';
import { existsSync, createReadStream } from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';

const FIXTURE = path.resolve('tests/fixtures/cold-start-tx-history.jsonl.gz');
const itIfFixture = existsSync(FIXTURE) ? it : it.skip;

describe('cold-start-tx-history fixture', () => {
  itIfFixture('decompresses and parses every line', async () => {
    const gunzip = zlib.createGunzip();
    createReadStream(FIXTURE).pipe(gunzip);
    const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
    let count = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.wallet).toBeDefined();
      expect(parsed.signature).toBeDefined();
      expect(parsed.tx).toBeDefined();
      count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(30); // 10 wallets × ≥3 sigs
  });
});
