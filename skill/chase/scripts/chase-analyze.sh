#!/usr/bin/env bash
# Analyze one Sui Move transaction and print the triaged result as JSON on stdout.
#
#   ./scripts/chase-analyze.sh <TX_DIGEST> [mainnet|testnet|devnet]
#
# Exit code is Chase's contract, not this wrapper's: 0 = clean, 1 = at least one violation,
# 2 = could not analyze. A caller that treats 1 as "the tool broke" will discard exactly the
# results it asked for.
#
# Uses a globally installed `chase` when present, otherwise runs from a Chase source checkout
# (set CHASE_SRC to point at it).
set -euo pipefail

digest="${1:?usage: chase-analyze.sh <TX_DIGEST> [network]}"
network="${2:-${SUI_NETWORK:-mainnet}}"

if command -v chase >/dev/null 2>&1; then
  exec chase triage "$digest" --network "$network" --json
fi

src="${CHASE_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
entry="$src/src/index.ts"

if [ ! -f "$entry" ]; then
  echo "chase-analyze.sh: no global 'chase' on PATH and no checkout at $src (set CHASE_SRC)" >&2
  exit 2
fi

exec npx --yes tsx "$entry" triage "$digest" --network "$network" --json
