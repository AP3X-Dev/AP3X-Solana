# Yellowstone protocol definitions

`yellowstone.proto` (upstream `geyser.proto`) and `solana-storage.proto` are from
rpcpool/yellowstone-grpc commit `1b0ee391722d765edb2c2bad2b854390bb3f8018`,
directory `yellowstone-grpc-proto/proto`. The upstream protocol package declares
Apache-2.0 in its [Cargo.toml](https://github.com/rpcpool/yellowstone-grpc/blob/1b0ee391722d765edb2c2bad2b854390bb3f8018/yellowstone-grpc-proto/Cargo.toml)
and supplies the accompanying `LICENSE_APACHE2`. This package-specific license
is distinct from the upstream repository's root license.

AP3X adds provenance headers and renames `geyser.proto` to `yellowstone.proto`.
The previous AP3X headers incorrectly described the protocol definitions as AGPL;
those headers have been corrected using the pinned package's license declaration.
AP3X TypeScript implementation code is covered by the package's MIT `LICENSE`.
