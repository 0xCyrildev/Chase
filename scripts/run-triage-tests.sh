#!/usr/bin/env bash
set -uo pipefail

# Regression fixtures are bundled in the repo, so the suites run offline on a fresh clone.
# Without this the tests silently depend on a developer machine cache and on testnet not wiping.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CHASE_CACHE_DIR="$SCRIPT_DIR/../test-cases/fixtures"

# An empty CHASE_HISTORY_FILE disables the triage history for both directions: no counters are read,
# so tiers can't drift, and no run ages its own fixtures toward the novelty penalty.
export CHASE_HISTORY_FILE=""

PASS=0
FAIL=0

while IFS= read -r line; do
  digest=$(echo "$line" | jq -r '.digest')
  label=$(echo "$line" | jq -r '.label')
  network=$(echo "$line" | jq -r '.network // "mainnet"')
  expect=$(echo "$line" | jq -r '.expectTiers // [] | sort | join(",")')

  echo "── $label"
  echo "   digest:  $digest"
  echo "   network: $network"

  tmp=$(mktemp)
  npx tsx src/triage/cli.ts "$digest" --network "$network" --json > "$tmp" 2>/dev/null || true
  output=$(cat "$tmp")
  rm -f "$tmp"

  actual=$(echo "$output" | jq -r '[.findings[].tier] | sort | join(",")' 2>/dev/null || echo "PARSE_ERROR")
  expected_sorted=$(echo "$expect" | tr ',' '\n' | sort | tr '\n' ',' | sed 's/,$//')

  if [ "$actual" = "$expected_sorted" ]; then
    echo "   pass (tiers: [$actual])"
    PASS=$((PASS + 1))
  else
    echo "   FAIL"
    echo "     expected: [$expected_sorted]"
    echo "     actual:   [$actual]"
    FAIL=$((FAIL + 1))
  fi
  echo
done < <(jq -c '.cases[]' test-cases/known-txs.json)

echo "passed: $PASS  failed: $FAIL"
exit $((FAIL > 0 ? 1 : 0))
