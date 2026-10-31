import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const lint = new ESLint();
async function errors(code, filePath = 'packages/solana-core/src/boundary-probe.ts') {
  const [result] = await lint.lintText(code, { filePath });
  assert.ok(!result.messages.some(m => m.fatal), JSON.stringify(result.messages));
  return result.messages.filter(m => m.severity === 2);
}
for (const code of [
  'import { WalletVault } from "@ap3x/solana-vault"; void WalletVault;',
  'import type { WalletVault } from "@ap3x/solana-vault";',
  'export { WalletVault } from "@ap3x/solana-vault";',
  'export * from "@ap3x/solana-vault/private";',
  'void import("@ap3x/solana-vault");',
  'void import(`@ap3x/solana-vault/private`);',
  'void require("@ap3x/solana-vault");',
  'type Vault = import("@ap3x/solana-vault").WalletVault;',
  'import Vault = require("@ap3x/solana-vault");',
]) test(`core layer rejects package dependency: ${code}`, async () => {
  assert.ok((await errors(code)).some(m => m.ruleId === 'workspace/dependencies'));
});
test('resolved relative imports still reject a reverse layer edge', async () => {
  assert.ok((await errors('import { WalletVault } from "../../solana-vault/src/index.ts"; void WalletVault;'))
    .some(m => m.ruleId === 'boundaries/dependencies'));
});
test('allowed layers, own package imports and Node modules remain valid', async () => {
  assert.deepEqual(await errors('import { PublicKey } from "@ap3x/solana-core"; void PublicKey;', 'packages/solana-connectivity/src/probe.ts'), []);
  assert.deepEqual(await errors('import { randomBytes } from "node:crypto"; void randomBytes;'), []);
  assert.deepEqual(await errors('import { PublicKey } from "@ap3x/solana-core"; void PublicKey;'), []);
});
test('SPL transaction-helper restrictions survive the lint migration', async () => {
  const file = 'packages/solana-spl/src/probe.ts';
  assert.deepEqual(await errors('import { findProgramAddress } from "@ap3x/solana-tx"; void findProgramAddress;', file), []);
  assert.ok((await errors('import { TransactionAssembler } from "@ap3x/solana-tx"; void TransactionAssembler;', file))
    .some(m => m.ruleId === 'no-restricted-imports'));
});
test('restricted helpers cannot be reached through an unlisted export, subpath, namespace, default or dynamic load', async () => {
  for (const code of [
    'import { decodeTransaction } from "@ap3x/solana-tx"; void decodeTransaction;',
    'import * as Tx from "@ap3x/solana-tx"; void Tx;',
    'import Tx from "@ap3x/solana-tx"; void Tx;',
    'import { assemble } from "@ap3x/solana-tx/private"; void assemble;',
    'void import("@ap3x/solana-tx");',
    'void require("@ap3x/solana-tx");',
  ]) assert.ok((await errors(code, 'packages/solana-spl/src/probe.ts')).length, code);
});
test('test fixtures retain their explicit cross-layer exemption', async () => {
  assert.deepEqual(await errors('import { WalletVault } from "@ap3x/solana-vault"; void WalletVault;', 'packages/solana-core/src/probe.test.ts'), []);
});
