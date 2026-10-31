import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const format = process.argv[2];
assert.ok(format === 'esm' || format === 'cjs', 'usage: node scripts/check-jito-proto.mjs esm|cjs');
const code = format === 'esm'
  ? 'import("./dist/proto/load.js").then(m => m.loadSearcherProto())'
  : 'require("./dist/proto/load.cjs").loadSearcherProto()';
// Pass code as one native argv entry; pnpm/cmd/PowerShell must not reinterpret it.
const result = spawnSync(process.execPath, ['-e', code], {
  cwd: fileURLToPath(new URL('../packages/solana-executor/', import.meta.url)),
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
