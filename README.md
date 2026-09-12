# Chase

Dynamic analysis tool for Sui Move transactions. Fetches execution traces
via gRPC and runs invariant checks to detect common vulnerability patterns.

```
   ▄████▄   ██░ ██  ▄▄▄       ██████  ▓█████
  ▒██▀ ▀█  ▓██░ ██▒▒████▄    ▒██    ▒  ▓█   ▀
  ▒▓█    ▄ ▒██▀▀██░▒██  ▀█▄  ░ ▓██▄    ▒███
  ▒▓▓▄ ▄██▒░▓█ ░██ ░██▄▄▄▄██   ▒   ██▒ ▒▓█  ▄
  ▒ ▓███▀ ░░▓█▒░██▓ ▓█   ▓██▒▒██████▒▒ ░▒████▒
  ░ ░▒ ▒  ░ ▒ ░░▒░▒ ▒▒   ▓▒█░▒ ▒▓▒ ▒ ░ ░░ ▒░ ░
    ░  ▒    ▒ ░▒░ ░  ▒   ▒▒ ░░ ░▒  ░ ░  ░ ░  ░
  ░         ░  ░░ ░  ░   ▒   ░  ░  ░      ░
  ░ ░       ░  ░  ░      ░         ░      ░  ░
  ░
```

## What it does

Given a transaction digest, Chase:

1. Fetches the full execution trace from a Sui fullnode via gRPC
2. Resolves the signature of every MoveCall in the PTB (with caching and retry)
3. Normalizes the response into a stable internal shape
4. Runs a set of invariant checks over the normalized trace
5. Reports findings with severity levels and supporting evidence

Chase is a dynamic analysis tool, which means it reasons about what a
transaction actually did on-chain, not what a contract's source code looks
like. This is complementary to static analysis and formal verification, and
it catches classes of issues (unexpected state changes, unexpected transfers,
suspicious call sequences) that source-level tools often miss.

Failed transactions are analyzed too. Attempted exploits often revert, and
the attempted call is still worth inspecting.

## Install

```bash
git clone https://github.com/0xCyrildev/Chase.git
cd Chase
npm install
cp .env.example .env
```

.env needs:

```
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
```

Only SUI_NETWORK is currently read. SUI_RPC_URL is reserved for a future
configurable-endpoint feature.

## Usage

```bash
# Human-readable report
npm run analyze -- <TX_DIGEST>

# Machine-readable JSON
npm run analyze -- <TX_DIGEST> --json

# Write report to file
npm run analyze -- <TX_DIGEST> --json -o reports/tx.json

# Full debug dump on stderr
npm run analyze -- <TX_DIGEST> --debug

# Skip the on-disk cache
npm run analyze -- <TX_DIGEST> --no-cache
```

Batch mode:

```bash
npm run batch -- digests.txt
npm run batch -- digests.txt -o reports/batch.ndjson
```

Watch mode:

```bash
npm run watch -- --limit 1
npm run watch -- --from 321400000 --filter 0xabc123 --limit 5
```

Cache management:

```bash
npm run cache -- --dir
npm run cache -- --clear
```

Exit code is 0 when no violations, 1 when at least one fires, 2 on error.
Usable in pipelines:

```bash
if ! npm run analyze -- "$DIGEST" --json > report.json; then
  echo "violations found in $DIGEST"
fi
```

## Invariants

Chase ships with five invariant checks. Each is intentionally conservative:
they fire on patterns worth a human looking at, not on confirmed exploits.

### address-balance-delta

Flags coin types where an address has a negative net balance change within a
transaction. Most fires are benign: when a coin flows into a shared object
(a pool, a vault, a Balance<T> inside a struct), the recipient side doesn't
appear in the address-based balanceChanges array, so the sender's debit
looks unmatched.

Severity: low

A real positive would show a coin type where the total address-based net
across all participants is nonzero and no shared object received the missing
amount. Distinguishing these requires reconstructing object-owned balances,
which is on the roadmap.

### mutable-access

Flags calls to public Move functions that return a &mut reference. Targets
the OpenZeppelin-documented bug class where an internal helper is
mistakenly declared public instead of public(package), allowing
attacker-deployed modules to obtain mutable references to sensitive objects.

Severity: high

Verified: fires on testnet digest
9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg against package
0x10172126::leak::leak_mut. See test-cases/synthetic-leak/ to reproduce.

Limitation: only flags functions whose return type is directly &mut T.
The public(package) exposure bug can also manifest through indirect access
paths, which this check doesn't see.

### ownership-anomaly

Flags object transfers to addresses that did not participate in the
transaction (neither as sender nor as a balance-change owner).

Severity: medium

Limitation: requires the recipient to be an address owner. Shared-object
mutations are ignored, which is correct since most modern DeFi keeps value
in shared pools, but it means the invariant is quiet on typical traffic.

### oracle-pattern

Flags transactions that call an oracle-update function followed by a DeFi
action (swap, liquidation, borrow, withdraw) in the same PTB. Heuristic for
the price-manipulation attack pattern seen in several Sui incidents.

Severity: high

Limitation: purely name-based matching against a small keyword list.
Legitimate protocols that update their own oracle then act on it will trip
this. Treat as a triage signal, not a verdict.

### repeated-module-calls

Flags PTBs that call into the same non-framework, non-router module five or
more times. Framework modules and known DeFi routers are filtered out.

Severity: low

Limitation: threshold tuned to 5 to avoid firing on every aggregator PTB.
Genuine repeated-call patterns below 5 go unreported. Lower the threshold
in src/invariants/repeated-module-calls.ts if you're hunting a specific
package.

## Architecture

```
src/
├── index.ts                    # CLI entry, command parsing
├── commands/
│   ├── analyze.ts              # orchestrates fetch -> check -> report
│   ├── batch.ts                # NDJSON batch mode
│   └── watch.ts                # checkpoint scanner
├── lib/
│   ├── banner.ts               # ASCII banner
│   ├── cache.ts                # on-disk trace cache
│   ├── fetcher.ts              # gRPC fetch + normalize + signature resolver
│   ├── reporter.ts             # human and JSON output
│   └── types.ts                # shared interfaces
└── invariants/
    ├── index.ts                # registry
    ├── token-conservation.ts   # address-balance-delta
    ├── mutable-access.ts       # public &mut return detection
    ├── ownership-anomaly.ts    # unexpected transfers
    ├── oracle-pattern.ts       # oracle + DeFi heuristic
    └── repeated-module-calls.ts
```

The fetcher resolves each MoveCall's signature via getMoveFunction to
determine returnsMutableRef. Results are cached by (package, module,
function) for the process lifetime.

## Caching

Chase caches normalized traces on disk at ~/.cache/chase/<digest>.json.
Repeat analyses of the same digest are near-instant and avoid hitting the
public fullnode.

```
npm run cache -- --dir      # print cache location
npm run cache -- --clear    # wipe all cached traces
```

Override the cache directory with CHASE_CACHE_DIR. Bypass with --no-cache.
## Testing

Fixtures live in `test-cases/known-txs.json`. Run the suite:

    ./scripts/run-tests.sh

Five cases:

- **mainnet** — clean order cancel, no violations
- **mainnet** — aggregator swap, produces `ADDRESS_OUTFLOW`
- **testnet** — synthetic `leak::leak_mut`, produces `MUTABLE_REFERENCE_RETURNED`
- **testnet** — synthetic `oracle::update_price` + `oracle::swap`, produces `ORACLE_MANIPULATION_SUSPECTED`
- **testnet** — synthetic `gift::give` to a non-participant, produces `UNEXPECTED_TRANSFER`

The three testnet cases come from a package in `test-cases/synthetic-leak/`.
Testnet is wiped periodically, so those digests may eventually stop resolving.
Re-publish the package and update `known-txs.json` when that happens — the
module source is in the repo so you can reproduce the exact same behavior.

    cd test-cases/synthetic-leak
    sui client switch --env testnet
    sui move build
    sui client publish --gas-budget 100000000
## Known limitations

- Retention window. Public fullnodes prune historical transactions. Anything
  older than roughly 21 days returns NOT_FOUND. The archival fallback hits
  archive.mainnet.sui.io, but that endpoint requires an X-Token header for
  authenticated access. For historical analysis at scale, use a provider
  like Triton or Quicknode, or run your own archival node.

- balanceChanges is address-scoped. Shared-object balance changes appear as
  effects.changedObjects mutations, not as address deltas. This is the root
  cause of most fires from address-balance-delta, which is why it's rated
  low severity and includes an explanatory note in its evidence.

- repeated-module-calls threshold is tuned high. Set to 5 calls per module
  to avoid firing on every DeFi aggregator PTB. Genuine repeated-call
  patterns below 5 go unreported.

- System transactions are skipped. Transactions with sender 0x0000...0000
  don't have programmable bodies and aren't returned by GetTransaction. The
  watcher catches this and skips silently.

- getMoveFunction is one RPC call per unique signature. Cached in-process
  and across runs via the trace cache, but a very large PTB touching many
  unfamiliar packages can exhaust the retry budget against a public
  fullnode.

- oracle-pattern is name-based. Legitimate protocols that update their own
  oracle then act on it will trip this. Treat as a triage signal.

- ownership-anomaly produces no signal on shared-object flows. The recipient
  must be an address owner for the check to fire.

- No testnet archival. The archival fallback is mainnet-only. Testnet wipes
  periodically.

## Roadmap

- [ ] A -> B -> A call pattern invariant (reentrancy-shaped composition)
- [ ] Capability-object misuse detection (TreasuryCap, AdminCap transfers)
- [ ] Flash-loan-shaped transaction heuristic
- [ ] Parallel fetch with concurrency limit
- [ ] Persist signature cache across runs
- [ ] Archival endpoint token support (ARCHIVE_TOKEN env var)
- [ ] MCP server wrapping chase_analyze and chase_query for agentic triage
- [ ] Positive test fixtures for oracle-pattern and ownership-anomaly

## Development

```bash
npm install
npm run analyze -- <DIGEST> --debug   # verify the fetcher works
```

Type checking:

```bash
npx tsc --noEmit
```

Build:

```bash
npm run build
npm start -- analyze <DIGEST>
```

## Acknowledgments

The mutable-access invariant is inspired by OpenZeppelin's published audit
findings on Sui Move visibility bugs. The oracle-pattern heuristic is
modelled on publicly documented Sui DeFi incidents.

## License

MIT. See LICENSE.
