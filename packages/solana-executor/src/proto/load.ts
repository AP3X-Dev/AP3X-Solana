/**
 * Jito proto loader helper.
 *
 * Loads the vendored `searcher.proto` + `bundle.proto` (and their transitive
 * dependencies `packet.proto` + `shared.proto`) via `@grpc/proto-loader` and
 * returns the `SearcherService` client constructor ready for use with
 * `@grpc/grpc-js`.
 *
 * The proto files are pinned to upstream commit `PINNED_COMMIT`. To upgrade,
 * re-fetch all four files from the same commit in jito-labs/mev-protos, update
 * the headers in each `.proto`, update `PINNED_COMMIT` here, and re-run tests.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Upstream commit of jito-labs/mev-protos that was vendored. */
export const PINNED_COMMIT = '46ead86a13a55a0ef2c139db96a8ee93bf7505e3';

/**
 * Load the Jito `SearcherService` proto definition.
 *
 * Both `searcher.proto` and `bundle.proto` are passed to `loadSync` so the
 * loader resolves the cross-file `import "bundle.proto"` from the same
 * directory. The `includeDirs` option ensures the transitive imports
 * (`packet.proto`, `shared.proto`) are also found alongside the two primary
 * files without requiring callers to set the working directory.
 */
export function loadSearcherProto(): {
  SearcherService: grpc.ServiceClientConstructor;
  packageDefinition: protoLoader.PackageDefinition;
} {
  const protoDir = __dirname;

  const packageDefinition = protoLoader.loadSync(
    [
      path.resolve(protoDir, 'searcher.proto'),
      path.resolve(protoDir, 'bundle.proto'),
    ],
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      // Include the proto dir so sibling imports (bundle.proto, packet.proto,
      // shared.proto) resolve regardless of the caller's cwd.
      includeDirs: [protoDir],
    },
  );

  const grpcObject = grpc.loadPackageDefinition(packageDefinition);
  // `grpcObject` is typed as `GrpcObject`, which is a recursively opaque
  // record — the library's type does not model the nested namespace structure.
  // Using `any` here is the standard pattern for proto-loader consumers; see
  // the upstream docs and the Yellowstone loader in solana-connectivity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ns = grpcObject as any;
  const SearcherService = ns.searcher.SearcherService as grpc.ServiceClientConstructor;

  return { SearcherService, packageDefinition };
}
