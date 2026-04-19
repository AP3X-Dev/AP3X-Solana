import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // The Yellowstone proto files are loaded at runtime by `@grpc/proto-loader`,
  // so they must ship alongside the compiled JS. Copy them after each build.
  async onSuccess() {
    const src = resolve(process.cwd(), 'src/proto');
    const dst = resolve(process.cwd(), 'dist/proto');
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
  },
});
