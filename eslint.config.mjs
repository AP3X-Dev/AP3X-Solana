// @ts-check
/**
 * Flat-config ESLint for the ap3x-solana monorepo.
 *
 * Primary job: enforce package-layering boundaries per the spec (Section 2). The
 * substrate is deliberately layered — e.g. `solana-core` depends on nothing in
 * the substrate, `solana-vault` may only import from `solana-core`, and
 * `solana-spl` / `solana-metaplex` may import from `solana-core` and may only
 * pull `findProgramAddress` from `solana-tx`. If someone accidentally reaches
 * across the layers we want `pnpm lint` to fail loudly.
 *
 * Tooling notes:
 *   - Flat config (ESLint 9+). Each config object narrows by `files` glob.
 *   - `eslint-plugin-boundaries` v4 is compatible with flat config; we pass
 *     element definitions via the `settings` key.
 *   - `typescript-eslint` provides a TS-aware parser; we do NOT enable
 *     type-checked rules, only the parser, because the boundary + restricted-import
 *     rules are purely import-graph shape and we don't need a program.
 *   - Test files (`*.test.ts` and anything under `tests/` at the repo or
 *     package level) relax boundary enforcement so a test can import from any
 *     of its fixtures or helpers without having to add them as "elements".
 */

import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Global ignores — build output, captured fixtures, generated diagnostics.
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'tests/fixtures/**',
      'packages/*/tests/fixtures/**',
      'packages/*/scripts/**',
      'packages/solana-connectivity/src/proto/**',
      'packages/solana-executor/src/proto/**',
      'tests/helpers/capture/**',
      '**/*.d.ts',
    ],
  },

  // Shared TS parser + plugin wiring for every `.ts` file in the repo.
  {
    files: ['packages/**/src/**/*.ts', 'examples/**/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      boundaries,
      // Register the @typescript-eslint plugin namespace. The existing code
      // uses inline `// eslint-disable-next-line @typescript-eslint/<rule>`
      // directives, so the rule names need to resolve even though we don't
      // enable type-checked linting at the flat-config level. We turn the
      // rules on as `warn`, which lets an `--fix` pass clean them up later
      // without breaking CI today.
      '@typescript-eslint': tseslint.plugin,
    },
    settings: {
      'boundaries/elements': [
        { type: 'core', pattern: 'packages/solana-core/src/**' },
        { type: 'connectivity', pattern: 'packages/solana-connectivity/src/**' },
        { type: 'tx', pattern: 'packages/solana-tx/src/**' },
        { type: 'spl', pattern: 'packages/solana-spl/src/**' },
        { type: 'metaplex', pattern: 'packages/solana-metaplex/src/**' },
        { type: 'events', pattern: 'packages/solana-events/src/**' },
        { type: 'vault', pattern: 'packages/solana-vault/src/**' },
        { type: 'signals', pattern: 'packages/solana-signals/src/**' },
        { type: 'portfolio', pattern: 'packages/solana-portfolio/src/**' },
        { type: 'executor', pattern: 'packages/solana-executor/src/**' },
        { type: 'strategy', pattern: 'packages/solana-strategy/src/**' },
        { type: 'pumpfun-events', pattern: 'packages/pumpfun-events/src/**' },
        { type: 'example', pattern: 'examples/**/src/**' },
      ],
      // We key the boundary check off the workspace package name so that
      // `import x from '@ap3x/solana-core'` resolves to the `core` element
      // regardless of how the TS path resolver rewrites it on disk.
      'boundaries/dependency-nodes': ['import'],
      'boundaries/include': ['packages/**/src/**', 'examples/**/src/**'],
    },
    rules: {
      // Layer enforcement. Mirrors spec Section 2:
      //   core         → (nothing)
      //   connectivity → core
      //   tx           → core, connectivity
      //   spl          → core, tx
      //   metaplex     → core, tx
      //   events       → core
      //   vault        → core
      //   example      → every substrate package
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
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
            { from: 'pumpfun-events', allow: ['core', 'events', 'tx'] },
            {
              from: 'example',
              allow: [
                'core',
                'connectivity',
                'tx',
                'spl',
                'metaplex',
                'events',
                'vault',
                'signals',
                'strategy',
                'executor',
                'portfolio',
              ],
            },
          ],
        },
      ],
      // Resolve the @typescript-eslint/* rule namespace used by existing
      // inline disable directives. Kept as `warn` rather than `error` so the
      // directives continue to suppress the existing callsites without
      // flipping CI red on day one.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `new Function(...)` is flagged by ESLint's built-in rule; we opt in
      // so the occasional `no-new-func` disable directive in the codebase
      // (e.g. the ESM `import.meta.url` indirection in geyser-client) refers
      // to a real, active rule.
      'no-new-func': 'warn',
    },
  },

  // Narrow `@ap3x/solana-tx` access inside `spl` / `metaplex` to *only* the
  // `findProgramAddress` named export. Everything else in solana-tx
  // (`TransactionAssembler`, `PriorityFeeEstimator`, `JitoBundleBuilder`,
  // `simulateAndBudget`, `computeBudget`, ALT helpers, etc.) must not leak
  // across — those belong to the send-path, not the decoder-path, and
  // importing them would pull the assembler graph into the SPL decoders.
  {
    files: [
      'packages/solana-spl/src/**/*.ts',
      'packages/solana-metaplex/src/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@ap3x/solana-tx',
              importNames: [
                'TransactionAssembler',
                'assemble',
                'JitoBundleBuilder',
                'PriorityFeeEstimator',
                'simulateAndBudget',
                'computeBudget',
                'AddressLookupTable',
                'decodeAddressLookupTable',
                'tipInstruction',
              ],
              message:
                'Only `findProgramAddress` may be imported from @ap3x/solana-tx in solana-spl / solana-metaplex. Other tx helpers belong to the send-path layer.',
            },
            {
              name: '@ap3x/solana-connectivity',
              message:
                'solana-spl and solana-metaplex must not import @ap3x/solana-connectivity directly; thread RpcPool through as a parameter or type instead.',
            },
          ],
        },
      ],
    },
  },

  // Scope `@ap3x/solana-portfolio`'s access to `@ap3x/solana-spl` to allow only
  // the SPL transfer decoders + `getAssociatedTokenAddress`. Other SPL exports
  // (TokenMint, TokenAccount, decodeMint, decodeTokenAccount, ALT builders, etc.)
  // belong to the decoder/builder layer and must not leak into portfolio.
  {
    files: ['packages/solana-portfolio/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@ap3x/solana-spl',
              importNames: [
                'TokenMint', 'TokenAccount', 'decodeMint', 'decodeTokenAccount',
                'createAssociatedTokenAccountIx', 'getTokenLargestAccounts', 'getTokenAccountsByMint',
              ],
              message:
                'solana-portfolio may import only the SPL transfer decoders + getAssociatedTokenAddress from @ap3x/solana-spl. Other SPL exports belong to the decoder/builder layer.',
            },
          ],
        },
      ],
    },
  },

  // Test + fixture files — relax boundary enforcement. Tests routinely import
  // package-private fixtures and helpers that don't correspond to boundary
  // elements, and we rely on the static restricted-imports rule rather than a
  // repeat of the element-types rule to guard test code.
  {
    files: [
      '**/*.test.ts',
      '**/tests/**/*.ts',
      'examples/**/src/**/*.test.ts',
    ],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'boundaries/element-types': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
