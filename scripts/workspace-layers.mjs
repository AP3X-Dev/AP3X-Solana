import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared by resolved-file and package-name checks; preserve the declared substrate layering.
export const layerPolicies = [
  { from: 'core', allow: [] },
  { from: 'connectivity', allow: ['core'] },
  { from: 'tx', allow: ['core', 'connectivity'] },
  { from: 'spl', allow: ['core', 'tx'] },
  { from: 'metaplex', allow: ['core', 'tx'] },
  { from: 'events', allow: ['core'] },
  { from: 'vault', allow: ['core'] },
  { from: 'signals', allow: ['core', 'connectivity', 'events'] },
  { from: 'portfolio', allow: ['core', 'connectivity', 'events', 'spl'] },
  { from: 'executor', allow: ['core', 'connectivity', 'tx', 'vault'] },
  { from: 'strategy', allow: ['core', 'signals', 'executor', 'portfolio', 'vault'] },
  { from: 'trading', allow: ['executor'] },
  { from: 'pumpfun-events', allow: ['core', 'events', 'tx'] },
  { from: 'pumpfun-protocol', allow: ['core', 'connectivity', 'events', 'spl', 'metaplex', 'tx', 'pumpfun-events'] },
  { from: 'example', allow: ['core', 'connectivity', 'tx', 'spl', 'metaplex', 'events', 'vault', 'signals',
    'strategy', 'trading', 'executor', 'portfolio', 'pumpfun-events', 'pumpfun-protocol'] },
];
const directory = type => type.startsWith('pumpfun-') ? type : `solana-${type}`;
const byDirectory = new Map(layerPolicies.filter(p => p.from !== 'example').map(p => [directory(p.from), p]));
const root = fileURLToPath(new URL('../', import.meta.url));
const literal = node => typeof node?.value === 'string' ? node.value
  : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0]?.value.cooked : null;

export const workspaceLayerPlugin = { rules: { dependencies: {
  meta: { type: 'problem', schema: [], messages: { forbidden: '{{from}} must not depend on {{to}}.', namedOnly: 'Use only permitted static named imports from {{to}}.' } },
  create(context) {
    const relative = path.relative(root, context.filename).replaceAll('\\', '/');
    const from = byDirectory.get(/^packages\/([^/]+)\/src\//.exec(relative)?.[1]);
    if (!from) return {};
    const allowed = new Set([directory(from.from), ...from.allow.map(directory)]);
    const check = (node, source) => {
      if (typeof source !== 'string') return;
      const target = /^@ap3x\/((?:solana|pumpfun)-[^/]+)(?:\/|$)/.exec(source)?.[1];
      if (target && !allowed.has(target)) context.report({ node, messageId: 'forbidden', data: { from: directory(from.from), to: target } });
      const namedOnly = (['spl', 'metaplex'].includes(from.from) && target === 'solana-tx') || (from.from === 'portfolio' && target === 'solana-spl');
      if (namedOnly && !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type))
        context.report({ node, messageId: 'namedOnly', data: { to: target } });
    };
    return {
      ImportDeclaration: node => check(node, literal(node.source)),
      ExportNamedDeclaration: node => check(node, literal(node.source)),
      ExportAllDeclaration: node => check(node, literal(node.source)),
      ImportExpression: node => check(node, literal(node.source)),
      TSImportType: node => check(node, literal(node.source ?? node.argument ?? node.parameter)),
      TSImportEqualsDeclaration: node => check(node, literal(node.moduleReference?.expression)),
      CallExpression: node => { if (node.callee.type === 'Identifier' && node.callee.name === 'require') check(node, literal(node.arguments[0])); },
    };
  },
} } };
