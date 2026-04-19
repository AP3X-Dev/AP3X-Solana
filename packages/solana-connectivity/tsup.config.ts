import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries — the library and the diag CLI. tsup emits
  // `dist/index.{js,cjs}` and `dist/diag/cli.{js,cjs}` with matching `.d.ts`
  // shells. The `bin` field in package.json points at the CJS cli output.
  entry: ['src/index.ts', 'src/diag/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Every emitted file gets a `#!/usr/bin/env node` header. This is strictly
  // required for `dist/diag/cli.*` so npm's bin symlink resolves against a
  // shebang-bearing script; it's inert as a JS comment in `dist/index.*` so
  // no consumer is affected.
  banner: { js: '#!/usr/bin/env node' },
  // The Yellowstone proto files are loaded at runtime by `@grpc/proto-loader`,
  // so they must ship alongside the compiled JS. Copy them after each build.
  async onSuccess() {
    const src = resolve(process.cwd(), 'src/proto');
    const dst = resolve(process.cwd(), 'dist/proto');
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
  },
});
