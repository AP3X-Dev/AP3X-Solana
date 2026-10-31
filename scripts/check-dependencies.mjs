import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const forbidden = new Set(['@solana/web3.js', '@solana/kit', '@solana/spl-token']);
function packageName(value) {
  if (typeof value !== 'string') return null;
  return /^(?:npm:)?(@[^/]+\/[^@/:]+)(?:@.*)?$/.exec(value)?.[1] ?? value;
}
/** Inspect resolved aliases and every transitive dependency in every workspace. */
export function forbiddenDependencies(projects) {
  const found = new Set();
  const pending = [...projects];
  while (pending.length) {
    const project = pending.pop();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [alias, dependency] of Object.entries(project[field] ?? {})) {
        for (const value of [alias, dependency.name, dependency.from, dependency.version]) {
          const name = packageName(value);
          if (name && (forbidden.has(name) || name.startsWith('@metaplex-foundation/'))) found.add(name);
        }
        pending.push(dependency);
      }
    }
  }
  return [...found].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manager = process.env.npm_execpath;
  if (!manager) throw new Error('Run through pnpm test:dependencies.');
  const args = ['-r', 'list', '--depth', 'Infinity', '--json'];
  const result = /\.(?:c?js|mjs)$/.test(manager)
    ? spawnSync(process.execPath, [manager, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(manager, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot inspect resolved dependency graph:\n${result.stderr}`);
  const projects = JSON.parse(result.stdout);
  const found = forbiddenDependencies(projects);
  if (found.length) throw new Error(`Forbidden resolved dependencies: ${found.join(', ')}`);
  console.log(`Dependency policy passed across ${projects.length} workspace projects.`);
}
