import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forbiddenDependencies } from '../scripts/check-dependencies.mjs';

test('the policy checks dependencies in non-root workspaces and nested optional/dev graphs', () => {
  assert.deepEqual(forbiddenDependencies([{ name: 'root' }, { name: 'outside-root', dependencies: {
    adapter: { devDependencies: { helper: { optionalDependencies: { '@solana/web3.js': { version: '1.98.4' } } } } },
  } }]), ['@solana/web3.js']);
});
test('all prohibited Solana packages and the full Metaplex namespace are rejected', () => {
  const names = ['@solana/web3.js', '@solana/kit', '@solana/spl-token', '@metaplex-foundation/new-package'];
  for (const name of names)
    assert.deepEqual(forbiddenDependencies([{ dependencies: { [name]: { version: '1.0.0' } } }]), [name]);
});
test('aliases cannot hide a prohibited package behind another dependency name', () => {
  for (const dependency of [
    { name: '@solana/kit' }, { from: '@solana/kit' }, { from: '@solana/kit@2.0.0' }, { version: 'npm:@solana/kit@2.0.0' },
  ]) assert.deepEqual(forbiddenDependencies([{ dependencies: { renamed: dependency } }]), ['@solana/kit']);
});
test('allowed primitives and similarly named packages do not produce false positives', () => {
  assert.deepEqual(forbiddenDependencies([{ dependencies: {
    '@ap3x/solana-core': { version: 'link:../solana-core' },
    '@solana/web3.js-tools': { version: '1.0.0' },
    '@noble/hashes': { version: '2.2.0' },
  } }]), []);
});
test('repeated paths retain one finding per forbidden dependency', () => {
  const dependency = { dependencies: { '@solana/spl-token': { version: '1.0.0' } } };
  assert.deepEqual(forbiddenDependencies([dependency, dependency]), ['@solana/spl-token']);
});
