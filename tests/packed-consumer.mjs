import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const packages = Object.keys(JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).dependencies);

test('packed dynamic ESM imports from CommonJS node -e use their own module paths', () => {
  const script = `
    const assert = require('node:assert/strict');
    (async () => {
      const helper = await import('./node_modules/@ap3x/solana-executor/dist/proto/load.js');
      assert.equal(typeof helper.loadSearcherProto().SearcherService, 'function');
      const geyser = await import('./node_modules/@ap3x/solana-connectivity/dist/index.js');
      const fs = require('node:fs');
      const path = require('node:path');
      const protoDir = geyser.resolveProtoDir();
      assert.ok(fs.existsSync(path.join(protoDir, 'yellowstone.proto')));
      const client = geyser.defaultGrpcAdapter.createClient(
        { url: 'http://127.0.0.1:1', insecure: true }, path.join(protoDir, 'yellowstone.proto'));
      client.close();
      const vault = await import('@ap3x/solana-vault');
      const key = await vault.deriveKey('compatibility-vector', new Uint8Array(16).fill(7), 1, 8192);
      assert.equal(key.length, 32);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
function exactDecoder(core, spl) {
  const keys = Array.from({ length: 4 }, (_, n) => core.PublicKey.fromBytes(new Uint8Array(32).fill(n + 1)));
  const ix = { programId: spl.SPL_TOKEN_2022_PROGRAM_ID, accounts: keys,
    data: Uint8Array.of(26, 1, 232, 3, 0, 0, 0, 0, 0, 0, 6, 7, 0, 0, 0, 0, 0, 0, 0) };
  const detail = spl.decodeTransferInstructionDetails(ix);
  assert.equal(detail.amount, 1000n);
  assert.equal(detail.expectedFee, 7n);
  assert.equal(detail.decimals, 6);
  assert.equal(detail.mint.toBase58(), keys[1].toBase58());
  assert.equal(detail.authority.toBase58(), keys[3].toBase58());
  assert.equal(spl.decodeTransferInstruction(ix), null);
}
for (const format of ['ESM', 'CommonJS']) {
  const load = name => format === 'ESM' ? import(name) : require(name);
  test(`packed ${format}: public entrypoints and exact transfer details`, async () => {
    const modules = new Map(await Promise.all(packages.map(async name => [name, await load(name)])));
    exactDecoder(modules.get('@ap3x/solana-core'), modules.get('@ap3x/solana-spl'));
    const core = modules.get('@ap3x/solana-core');
    assert.equal(core.rpcU64('18446744073709551615'), 18446744073709551615n);
    assert.throws(() => core.rpcU64(Number.MAX_SAFE_INTEGER + 1));
    const connectivity = modules.get('@ap3x/solana-connectivity');
    assert.ok(existsSync(path.join(connectivity.resolveProtoDir(), 'yellowstone.proto')));
  });
  test(`packed ${format}: Argon2id compatibility, authenticated encryption and tamper refusal`, async () => {
    const vault = await load('@ap3x/solana-vault');
    const key = await vault.deriveKey('compatibility-vector', new Uint8Array(16).fill(7), 1, 8192);
    // Generated using the previous unpatched public CommonJS sumo dependency.
    assert.equal(Buffer.from(key).toString('hex'), 'fe75400ae1d9567037cc0708382ead8b7b6d89d8689e4e4bcc55b136b229ea61');
    const plain = Uint8Array.of(1, 2, 3);
    const { nonce, ciphertext } = await vault.encrypt(key, plain);
    assert.deepEqual(await vault.decrypt(key, nonce, ciphertext), plain);
    ciphertext[0] ^= 1;
    await assert.rejects(() => vault.decrypt(key, nonce, ciphertext));
  });
  test(`packed ${format}: invocation identity distinguishes unlogged outer instructions and ancestor rollback`, async () => {
    const { mapInvocationContext } = await load('@ap3x/solana-events');
    const a = '11111111111111111111111111111111';
    const b = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const c = 'ComputeBudget111111111111111111111111111111';
    const result = mapInvocationContext({ execution: 'succeeded', innerInstructionsRecorded: true,
      instructions: [{ programId: c, outerIndex: 0, innerIndex: null, stackHeight: null },
        { programId: a, outerIndex: 1, innerIndex: null, stackHeight: null },
        { programId: b, outerIndex: 1, innerIndex: 0, stackHeight: 2 }],
      logMessages: [`Program ${a} invoke [1]`, `Program ${b} invoke [2]`, `Program ${b} success`,
        `Program ${a} failed: custom program error: 1`] });
    assert.equal(result.status, 'mapped');
    assert.deepEqual(result.invocations.map(i => [i.rootOrdinal, i.outerIndex, i.innerIndex, i.applied]), [[0, 1, null, false], [0, 1, 0, false]]);
  });
  test(`packed ${format}: unresolved portfolio settlement survives restart and resolves once`, async () => {
    const core = await load('@ap3x/solana-core');
    const { FilePortfolioStore } = await load('@ap3x/solana-portfolio');
    const tempRoot = path.resolve(tmpdir());
    const dir = mkdtempSync(path.join(tempRoot, 'ap3x-portfolio-packed-'));
    try {
      const wallet = core.PublicKey.fromBytes(new Uint8Array(32).fill(71));
      const mint = core.PublicKey.fromBytes(new Uint8Array(32).fill(72));
      const store = new FilePortfolioStore({ dir });
      const buy = { wallet, mint, signature: 'buy', slot: 1, amountDelta: 100n, solFlowLamports: -1000n, feeLamports: 0n, source: 'external' };
      await store.applyLandedTrade(buy);
      const sale = { ...buy, signature: 'sale', slot: 2, amountDelta: -50n, solFlowLamports: null };
      await store.applyLandedTrade(sale);
      const reopened = new FilePortfolioStore({ dir });
      await assert.rejects(() => reopened.getRealizedPnl(wallet, mint), error => error.code === 'portfolio.pnl_unresolved');
      assert.equal((await reopened.getPosition(wallet, mint)).lots[0].amount, 50n);
      assert.equal((await reopened.getRealizedPnlStatus(wallet, mint)).complete, false);
      await reopened.resolveRealizedPnl(wallet, mint, 'sale', 1500n, 500n);
      await reopened.resolveRealizedPnl(wallet, mint, 'sale', 1500n, 500n);
      assert.equal(await reopened.getRealizedPnl(wallet, mint), 1000n);
      assert.deepEqual(await reopened.applyLandedTrade(sale), []);
    } finally {
      assert.equal(path.dirname(path.resolve(dir)), tempRoot);
      assert.ok(path.basename(dir).startsWith('ap3x-portfolio-packed-'));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test(`packed ${format}: Jito proto helper finds only installed runtime assets`, async () => {
    const base = './node_modules/@ap3x/solana-executor/dist/proto/load.';
    const helper = format === 'ESM' ? await import(base + 'js') : require(base + 'cjs');
    assert.equal(typeof helper.loadSearcherProto().SearcherService, 'function');
  });
}
