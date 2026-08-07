#!/usr/bin/env bash
# Restart-recovery E2E harness.
#
# Each scenario under scenarios/ is a self-contained bash script that:
#  1. seeds a fresh sandbox sqlite DB with a specific pre-crash state,
#  2. starts the API (which runs recoverOnStartup during boot),
#  3. verifies the DB and log reflect the expected recovered state.
#
# Usage:
#   scripts/e2e/restart-recovery.sh                     # run all scenarios
#   scripts/e2e/restart-recovery.sh 01 04               # run selected ones
#
# Requirements: sqlite3 CLI, curl, pnpm, the project installed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCENARIOS_DIR="$(cd "$(dirname "$0")" && pwd)/scenarios"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[e2e] sqlite3 CLI not found — install it and retry" >&2
  exit 2
fi

ALL_SCENARIOS=()
while IFS= read -r line; do
  ALL_SCENARIOS+=("$line")
done < <(find "$SCENARIOS_DIR" -maxdepth 1 -name '*.sh' | sort)

if [[ $# -gt 0 ]]; then
  SELECTED=()
  for arg in "$@"; do
    match="$(printf '%s\n' "${ALL_SCENARIOS[@]}" | grep -E "/${arg}-" || true)"
    if [[ -z "$match" ]]; then
      echo "[e2e] no scenario matches '$arg'" >&2
      exit 2
    fi
    SELECTED+=("$match")
  done
else
  SELECTED=("${ALL_SCENARIOS[@]}")
fi

echo "[e2e] running ${#SELECTED[@]} scenario(s)"

FAIL_COUNT=0
for scenario in "${SELECTED[@]}"; do
  name="$(basename "$scenario" .sh)"
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "▶ $name"
  echo "════════════════════════════════════════════════════════════════"
  if bash "$scenario"; then
    echo "✓ $name"
  else
    echo "✗ $name FAILED (exit $?)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

echo ""
echo "════════════════════════════════════════════════════════════════"
if (( FAIL_COUNT == 0 )); then
  echo "✓ all scenarios passed"
  exit 0
else
  echo "✗ $FAIL_COUNT scenario(s) failed"
  exit 1
fi
