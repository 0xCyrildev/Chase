#!/usr/bin/env bash
set -uo pipefail

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
  SUI_NETWORK="$network" npx tsx src/triage/cli.ts "$digest" --json > "$tmp" 2>/dev/null || true
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
