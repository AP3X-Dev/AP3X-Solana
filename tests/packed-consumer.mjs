import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packages = Object.keys(JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).dependencies);
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
  test(`packed ${format}: Jito proto helper finds only installed runtime assets`, async () => {
    const base = './node_modules/@ap3x/solana-executor/dist/proto/load.';
    const helper = format === 'ESM' ? await import(base + 'js') : require(base + 'cjs');
    assert.equal(typeof helper.loadSearcherProto().SearcherService, 'function');
  });
}
