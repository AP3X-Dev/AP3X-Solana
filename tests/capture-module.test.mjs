import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('capture helpers expose named exports to ESM diagnostic scripts', () => {
  const code = `
    import assert from 'node:assert/strict';
    import { rpc, rpcUrl, signatures, base58Decode } from './tests/helpers/capture/_rpc.ts';
    assert.equal(typeof rpc, 'function');
    assert.equal(typeof signatures, 'function');
    assert.equal(rpcUrl(), 'http://127.0.0.1:1');
    assert.deepEqual(base58Decode('111'), new Uint8Array(3));
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, RPC_URL: 'http://127.0.0.1:1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});
