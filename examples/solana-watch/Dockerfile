# Dockerfile for the solana-watch acceptance run.
#
# Build context is the monorepo root (NOT examples/solana-watch) so pnpm can
# see every workspace package. Invoke from the repo root with:
#
#   docker build -f examples/solana-watch/Dockerfile -t solana-watch .
#
# The image runs a single-file ESM bundle produced by tsup. All substrate
# packages are built ahead of time via `pnpm -r build` so the final image
# carries only the files it needs at runtime.

# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS builder

WORKDIR /app

# Corepack ships with Node 20 and activates the pnpm version pinned in
# package.json (`packageManager` field), so the build uses the same toolchain
# the developer does.
RUN corepack enable

# Copy workspace manifest files first to leverage Docker layer caching on
# dependency-only changes. The subsequent source COPY will bust the cache
# only when code actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY packages ./packages
COPY examples ./examples

# Install with a frozen lockfile; the workspace layout means all cross-package
# deps resolve to workspace:* symlinks and nothing hits the network beyond
# devDependencies.
RUN pnpm install --frozen-lockfile

# Build every substrate package, then the example. Turbo handles the topo
# sort — solana-core builds first, etc.
RUN pnpm -r --filter "./packages/*" build
RUN pnpm --filter solana-watch build

# -----------------------------------------------------------------------------
# Runtime image — minimal Node alpine, prod deps only.
# -----------------------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

RUN corepack enable

# Bring over the manifest + built output. The `--prod` install produces a
# node_modules with devDependencies pruned but workspace symlinks intact.
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/patches ./patches
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/examples/solana-watch/package.json ./examples/solana-watch/
COPY --from=builder /app/examples/solana-watch/dist ./examples/solana-watch/dist

RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production

WORKDIR /app/examples/solana-watch
ENTRYPOINT ["node", "dist/main.js"]
