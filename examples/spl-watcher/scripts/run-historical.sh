#!/usr/bin/env bash
# Run spl-watcher against an RPC endpoint for a slot range.
#
# Usage: scripts/run-historical.sh <rpc-url> <from-slot> <to-slot> <wallet> [<wallet>...]
#
# Example:
#   scripts/run-historical.sh https://mainnet.helius-rpc.com/?api-key=xxx 280000000 280001000 \
#     11111111111111111111111111111112
#
# Note: On Windows, run via Git Bash or WSL. chmod +x is not needed in Git Bash
# but you may need: bash scripts/run-historical.sh ...
set -euo pipefail

RPC="${1:?missing rpc url}"
FROM="${2:?missing from slot}"
TO="${3:?missing to slot}"
shift 3

ARGS=()
for w in "$@"; do
  ARGS+=(--wallet "$w")
done

node "$(dirname "$0")/../dist/index.js" --rpc "$RPC" --from "$FROM" --to "$TO" "${ARGS[@]}"
