import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries — the library and the proto loader helper. tsup emits
  // `dist/index.{js,cjs}` and `dist/proto/load.{js,cjs}` with matching `.d.ts`
  // shells. The proto loader is a standalone import target for the CI gate
  // (`import("./dist/proto/load.js")`) and for consumers that need direct
  // access to the `SearcherService` constructor.
  entry: ['src/index.ts', 'src/proto/load.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // The Jito proto files are loaded at runtime by `@grpc/proto-loader`,
  // so they must ship alongside the compiled JS. Copy them after each build.
  async onSuccess() {
    const src = resolve(process.cwd(), 'src/proto');
    const dst = resolve(process.cwd(), 'dist/proto');
    mkdirSync(dst, { recursive: true });
    cpSync(src, dst, { recursive: true });
  },
});
