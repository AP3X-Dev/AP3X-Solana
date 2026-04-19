#!/usr/bin/env bash
# solana-watch acceptance harness.
#
# Runs the container for ${DURATION} seconds (default 3600 = 1h), captures
# stdout to a JSONL file, computes p50/p99 of the `latencyMs` field across
# every decoded event, and exits non-zero if either percentile exceeds its
# threshold.
#
# Environment:
#   DURATION         seconds to run the container (default: 3600)
#   THRESHOLD_P50    p50 latency ceiling in ms (default: 500)
#   THRESHOLD_P99    p99 latency ceiling in ms (default: 2000)
#   MIN_EVENTS       minimum event count before percentiles are trusted
#                    (default: 100) — fewer and we treat it as a sampling
#                    failure and exit non-zero.
#   GEYSER_URL       Yellowstone gRPC endpoint URL (required)
#   GEYSER_TOKEN     optional bearer token for --geyser-token
#   PROGRAMS         comma-separated list of base58 program IDs (required)
#
# Dependencies on the host: docker, jq, awk. All three are standard on the
# Linux CI runner; Windows CI is skipped by the matrix (see plan Task 32).

set -euo pipefail

DURATION="${DURATION:-3600}"
THRESHOLD_P50="${THRESHOLD_P50:-500}"
THRESHOLD_P99="${THRESHOLD_P99:-2000}"
MIN_EVENTS="${MIN_EVENTS:-100}"
OUT_FILE="${OUT_FILE:-/tmp/solana-watch-output.jsonl}"

: "${GEYSER_URL:?GEYSER_URL required}"
: "${PROGRAMS:?PROGRAMS required (comma-separated base58 program IDs)}"

# Resolve script dir so we can locate the monorepo root regardless of where
# acceptance.sh is invoked from. The Dockerfile's build context is the repo
# root, two levels up from scripts/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

echo "[acceptance] building image..."
docker build \
  -f "${REPO_ROOT}/examples/solana-watch/Dockerfile" \
  -t solana-watch-acceptance \
  "${REPO_ROOT}"

# Build the --program args one per value. `tr` + `xargs` keeps quoting simple
# without invoking an eval.
PROGRAM_ARGS=()
IFS=',' read -ra PROGRAM_LIST <<< "${PROGRAMS}"
for p in "${PROGRAM_LIST[@]}"; do
  PROGRAM_ARGS+=("--program" "${p}")
done

TOKEN_ARGS=()
if [ -n "${GEYSER_TOKEN:-}" ]; then
  TOKEN_ARGS+=("--geyser-token" "${GEYSER_TOKEN}")
fi

echo "[acceptance] running container for ${DURATION}s..."
# `timeout` handles the duration; `|| true` keeps a SIGTERM-terminated
# container from failing the script (exit code 124 = timeout).
CONTAINER_NAME="solana-watch-acceptance-$$"
timeout --preserve-status "${DURATION}s" docker run --rm \
  --name "${CONTAINER_NAME}" \
  solana-watch-acceptance \
  --geyser "${GEYSER_URL}" \
  "${TOKEN_ARGS[@]}" \
  "${PROGRAM_ARGS[@]}" \
  > "${OUT_FILE}" 2>/tmp/solana-watch-stderr.log || true

echo "[acceptance] captured $(wc -l < "${OUT_FILE}") lines to ${OUT_FILE}"

# Extract latencyMs from every JSON line. `jq -r` tolerates stray stderr bleed
# via `--jsonargs` style parsing but we pipe a clean file here. `-e` would
# fail the whole pipeline on missing fields; we accept empty lines instead.
LATENCIES_FILE=/tmp/solana-watch-latencies.txt
jq -r 'select(.latencyMs != null) | .latencyMs' "${OUT_FILE}" \
  | sort -n > "${LATENCIES_FILE}"

COUNT=$(wc -l < "${LATENCIES_FILE}")
echo "[acceptance] event count: ${COUNT}"

if [ "${COUNT}" -lt "${MIN_EVENTS}" ]; then
  echo "[acceptance] FAIL: fewer than ${MIN_EVENTS} events captured; percentiles not trustworthy"
  exit 1
fi

# awk percentile: nearest-rank. p = ceil(count * pct/100).
P50_IDX=$(awk -v n="${COUNT}" 'BEGIN { v = n * 0.50; i = int(v); if (v > i) i++; if (i < 1) i = 1; print i }')
P99_IDX=$(awk -v n="${COUNT}" 'BEGIN { v = n * 0.99; i = int(v); if (v > i) i++; if (i < 1) i = 1; print i }')

P50=$(sed -n "${P50_IDX}p" "${LATENCIES_FILE}")
P99=$(sed -n "${P99_IDX}p" "${LATENCIES_FILE}")

echo "[acceptance] p50=${P50}ms (threshold ${THRESHOLD_P50}ms)"
echo "[acceptance] p99=${P99}ms (threshold ${THRESHOLD_P99}ms)"

# Integer comparison — latencyMs is emitted as an integer ms from Date.now.
FAILED=0
if [ "${P50}" -gt "${THRESHOLD_P50}" ]; then
  echo "[acceptance] FAIL: p50 above threshold"
  FAILED=1
fi
if [ "${P99}" -gt "${THRESHOLD_P99}" ]; then
  echo "[acceptance] FAIL: p99 above threshold"
  FAILED=1
fi

if [ "${FAILED}" -ne 0 ]; then
  exit 1
fi

echo "[acceptance] PASS"
