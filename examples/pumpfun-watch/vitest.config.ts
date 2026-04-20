import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Point workspace packages at their source so Vitest doesn't need pre-built dist.
      '@ap3x/solana-signals': path.resolve(__dirname, '../../packages/solana-signals/src/index.ts'),
      '@ap3x/solana-strategy': path.resolve(__dirname, '../../packages/solana-strategy/src/index.ts'),
      '@ap3x/solana-events': path.resolve(__dirname, '../../packages/solana-events/src/index.ts'),
      '@ap3x/solana-core': path.resolve(__dirname, '../../packages/solana-core/src/index.ts'),
      '@ap3x/solana-connectivity': path.resolve(__dirname, '../../packages/solana-connectivity/src/index.ts'),
      '@ap3x/pumpfun-events': path.resolve(__dirname, '../../packages/pumpfun-events/src/index.ts'),
      '@ap3x/pumpfun-protocol': path.resolve(__dirname, '../../packages/pumpfun-protocol/src/index.ts'),
    },
  },
  test: {
    // Include both src unit tests and tests/ integration tests.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
