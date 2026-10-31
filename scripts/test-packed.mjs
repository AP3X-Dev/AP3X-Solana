import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manager = process.env.npm_execpath;
assert.ok(manager, 'Run this check through pnpm test:packed. Build packages first.');
const tempRoot = path.resolve(os.tmpdir());
const temp = fs.mkdtempSync(path.join(tempRoot, 'ap3x-packed-'));
const archives = path.join(temp, 'archives');
const consumer = path.join(temp, 'consumer');
fs.mkdirSync(archives);
fs.mkdirSync(consumer);
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function pnpm(args, cwd, env) {
  return /\.(?:c?js|mjs)$/.test(manager)
    ? run(process.execPath, [manager, ...args], cwd, env)
    : run(manager, args, cwd, env);
}
try {
  const dependencies = {};
  const versions = {};
  const manifests = [];
  for (const name of fs.readdirSync(path.join(root, 'packages'))) {
    const directory = path.join(root, 'packages', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
    if (manifest.private) continue;
    pnpm(['pack', '--pack-destination', archives], directory);
    const archive = path.join(archives, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`);
    const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.ok(entries.every(e => /^package\/(?:dist\/|package\.json$|README\.md$|LICENSE$)/.test(e)), `unexpected packed file in ${name}`);
    const read = entry => execFileSync('tar', ['-xOf', archive, `package/${entry}`]);
    for (const entry of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts', 'README.md', 'LICENSE'])
      assert.ok(entries.includes(`package/${entry}`), `missing ${entry} in ${name}`);
    assert.ok(read('LICENSE').equals(fs.readFileSync(path.join(root, 'LICENSE'))));
    const packed = JSON.parse(read('package.json'));
    versions[packed.name] = packed.version;
    manifests.push(packed);
    assert.ok(Object.values(packed.dependencies ?? {}).every(v => !v.startsWith('workspace:')));
    if (name === 'solana-connectivity' || name === 'solana-executor') {
      assert.equal(packed.license, '(MIT AND Apache-2.0)');
      assert.ok(read('dist/proto/LICENSE_APACHE2').equals(fs.readFileSync(path.join(directory, 'src/proto/LICENSE_APACHE2'))));
      assert.ok(entries.includes('package/dist/proto/NOTICE.md'));
    }
    dependencies[manifest.name] = `file:${archive.replaceAll('\\', '/')}`;
  }
  for (const packed of manifests) for (const [name, version] of Object.entries(packed.dependencies ?? {}))
    if (name.startsWith('@ap3x/')) assert.equal(version, versions[name], `internal packed dependency mismatch: ${packed.name} -> ${name}`);
  console.log(`Packed ${manifests.length} public packages; private packages excluded.`);
  // Resolve unpublished internal versions from these tarballs too. Only AP3X
  // names are overridden; third-party dependencies receive no workspace patch.
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'ap3x-packed-consumer', private: true, type: 'module', dependencies, pnpm: { overrides: dependencies } }));
  for (const name of ['user.npmrc', 'global.npmrc']) fs.writeFileSync(path.join(temp, name), 'registry=https://registry.npmjs.org/\n');
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: path.join(temp, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(temp, 'global.npmrc') };
  const install = ['install', '--ignore-scripts', '--no-frozen-lockfile'];
  if (process.env.AP3X_PACK_TEST_STORE) install.push('--store-dir', process.env.AP3X_PACK_TEST_STORE);
  pnpm(install, consumer, env);
  fs.copyFileSync(path.join(root, 'tests/packed-consumer.mjs'), path.join(consumer, 'consumer.test.mjs'));
  console.log(run(process.execPath, ['--test', 'consumer.test.mjs'], consumer, env));
  // Only remove the fresh test directory owned by this invocation.
  assert.equal(path.dirname(path.resolve(temp)), tempRoot);
  assert.ok(path.basename(temp).startsWith('ap3x-packed-'));
  fs.rmSync(temp, { recursive: true, force: true });
} catch (error) {
  console.error(`Packed consumer check failed; retained artifacts: ${temp}`);
  throw error;
}
