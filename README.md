# Chase

Dynamic analysis tool for Sui Move transactions built by yours truly. It
fetches execution traces via gRPC and runs invariant checks to detect common
vulnerability patterns.

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

Chase is a **dynamic analysis** tool. It reasons about what a transaction
actually did on-chain, not what a contract's source code looks like. This is
complementary to static analysis and formal verification, and it catches
classes of issues (unexpected state changes, unexpected transfers, suspicious
call sequences) that source-level tools often miss.

Failed transactions are analyzed too. Attempted exploits often revert, and
the attempted call is still worth inspecting.

Chase ships as a **CLI**, a **library**, and an **MCP server**, so it can be
run by a human, imported into a script, or called directly by an AI agent.

## Install

```bash
git clone https://github.com/0xCyrildev/Chase.git
cd Chase
npm install
cp .env.example .env
```

`.env` needs:

```
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
```

Only `SUI_NETWORK` is currently read. `SUI_RPC_URL` is reserved for a future
configurable-endpoint feature.

## Usage

### CLI

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
npm run batch -- digests.txt -o reports/batch.ndjson -c 10
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
npm run cache                # show signature count
```

Exit code is `0` when no violations, `1` when at least one fires, `2` on error.

### Library

```typescript
import { runAnalysis } from "./commands/analyze.js";

const report = await runAnalysis(digest, false, true);
console.log(report.violations);
```

### MCP server

Chase exposes three tools over the Model Context Protocol:

- `chase_analyze` — fetch a trace and run invariants on a digest
- `chase_query` — report signature cache state and cache directory
- `chase_watch` — bounded checkpoint range scan with optional filter

Run it:

```bash
npm run mcp
```

Or point any MCP client at `npx tsx /path/to/Chase/src/mcp-server.ts`.

**Claude Code:**

```bash
claude mcp add --transport stdio --scope user chase -- npx tsx /path/to/Chase/src/mcp-server.ts
claude mcp list
```

**Codex CLI:**

```bash
codex mcp add chase -- npx tsx /path/to/Chase/src/mcp-server.ts
codex mcp list
```

**MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector npx tsx src/mcp-server.ts
```

The server speaks MCP protocol version 2025-06-18 over stdio.

## Invariants

Chase ships with eight invariant checks. Each is intentionally conservative:
they fire on patterns worth a human looking at, not on confirmed exploits.

Four of them have **positive controls**: synthetic Move packages published to
testnet that trigger the detector on demand. Those are marked **Verified**.

### address-balance-delta

Flags coin types where an address has a negative net balance change within a
transaction. Most fires are benign: when a coin flows into a shared object,
the recipient side doesn't appear in the address-based `balanceChanges`
array, so the sender's debit looks unmatched.

**Severity:** low

A real positive would show a coin type where the total address-based net
across all participants is nonzero and no shared object received the missing
amount. Distinguishing these requires reconstructing object-owned balances,
which is on the roadmap.

### mutable-access

Flags calls to `public` Move functions that return a `&mut` reference.
Targets the OpenZeppelin-documented bug class where an internal helper is
mistakenly declared `public` instead of `public(package)`, allowing
attacker-deployed modules to obtain mutable references to sensitive objects.

**Severity:** high

**Verified:** fires on testnet digest
`9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg`. Synthetic source in
`test-cases/synthetic-leak/sources/leak.move`.

**Limitation:** only flags functions whose return type is directly `&mut T`.
The `public(package)` exposure bug can also manifest through indirect access
paths, which this check doesn't see.

### ownership-anomaly

Flags object transfers to addresses that did not participate in the
transaction.

**Severity:** medium

**Verified:** fires on testnet digest
`EpcqsX3RHDwpE2YAqHcfcKtDExjTBkz5FczQUk9PB4gp`. Synthetic source in
`test-cases/synthetic-leak/sources/transfer.move`.

**Limitation:** requires the recipient to be an address owner. Shared-object
mutations are ignored, which is correct since most modern DeFi keeps value
in shared pools, but it means the invariant is quiet on typical traffic.

### oracle-pattern

Flags transactions that call an oracle-update function followed by a DeFi
action in the same PTB. Heuristic for the price-manipulation attack pattern
seen in several Sui incidents.

**Severity:** high

**Verified:** fires on testnet digest
`7Y3T5H7oXRhG1vjhnAERiseYW6tY4XndAfHSrrbVwKT2`. Synthetic source in
`test-cases/synthetic-leak/sources/oracle.move`.

**Limitation:** purely name-based matching against a small keyword list.
Legitimate protocols that update their own oracle then act on it will trip
this. Treat as a triage signal, not a verdict.

### repeated-module-calls

Flags PTBs that call into the same non-framework, non-router module five or
more times.

**Severity:** low

**Limitation:** threshold tuned to 5 to avoid firing on every aggregator
PTB. Genuine repeated-call patterns below 5 go unreported.

### reentrancy-pattern

Flags `A -> B -> A` call sequences: the same function is called, then a
different function, then the first function again. Tracks at function level,
not module level, so `hop::first -> hop::second -> hop::first` is caught even
though both functions share a module.

**Severity:** medium

**Verified:** fires on testnet digest
`GoZD6MFDHs6b8u8WLtc7V74iSjwrS2XztXiqPyvPYzzd`. Synthetic source in
`test-cases/synthetic-leak/sources/hop.move`.

**Limitation:** aggregators that call shared helper functions across
multiple hops (e.g. `coin_utils::transfer_nonzero` in Cetus routers) will
trip this. It's a real composition pattern, but usually benign in DEX
routing. Treat as a triage signal, not a verdict.

### flash-loan-shaped

Flags PTBs that call a function matching borrow/flash_loan keywords,
followed by a DeFi action (swap, liquidate, arbitrage), followed by a
function matching repay/return_flash keywords.

**Severity:** medium

**Limitation:** name-based. No synthetic positive control yet. Treat as a
triage signal.

### capability-transfer

Flags transfers of capability objects (`TreasuryCap`, `AdminCap`,
`UpgradeCap`, `OwnerCap`, `MintCap`, `BurnCap`) to addresses other than the
transaction sender.

**Severity:** high

**Limitation:** name-based on the object type string. No synthetic positive
control yet. Treat as a triage signal.

## Architecture

```
src/
├── index.ts                    # CLI entry, command parsing
├── mcp-server.ts               # MCP server (stdio transport)
├── commands/
│   ├── analyze.ts              # orchestrates fetch -> check -> report
│   ├── batch.ts                # NDJSON batch mode with concurrency
│   └── watch.ts                # checkpoint scanner
├── lib/
│   ├── banner.ts               # ASCII banner
│   ├── cache.ts                # on-disk trace cache
│   ├── concurrency.ts          # bounded parallel map
│   ├── fetcher.ts              # gRPC fetch + normalize + signature resolver
│   ├── reporter.ts             # human and JSON output
│   ├── sigcache.ts             # persisted signature cache
│   └── types.ts                # shared interfaces
└── invariants/
    ├── index.ts                # registry
    ├── token-conservation.ts   # address-balance-delta
    ├── mutable-access.ts       # public &mut return detection
    ├── ownership-anomaly.ts    # unexpected transfers
    ├── oracle-pattern.ts       # oracle + DeFi heuristic
    ├── repeated-module-calls.ts
    ├── reentrancy-pattern.ts   # A -> B -> A composition
    ├── flash-loan-shaped.ts    # borrow -> action -> repay
    └── capability-transfer.ts  # capability object transfers
```

The fetcher resolves each MoveCall's signature via `getMoveFunction` to
determine `returnsMutableRef`. Results are cached in memory and on disk,
keyed by `package::module::function`.

## Caching

Chase caches two things on disk:

- Normalized traces at `~/.cache/chase/<digest>.json`
- Move function signatures at `~/.cache/chase/signatures.json`

Repeat analyses of the same digest are near-instant and avoid hitting the
public fullnode. Signature resolution is skipped entirely for functions
already cached.

```bash
npm run cache -- --dir      # print cache location
npm run cache -- --clear    # wipe traces and signatures
npm run cache                # show signature count
```

Override the cache directory with `CHASE_CACHE_DIR`. Bypass trace cache with
`--no-cache`.

## Testing

Fixtures live in `test-cases/known-txs.json`. Run the suite:

```bash
./scripts/run-tests.sh
```

Six cases:

- **mainnet** — clean order cancel, no violations
- **mainnet** — aggregator swap, produces `ADDRESS_OUTFLOW` and `REENTRANCY_PATTERN`
- **testnet** — synthetic `leak::leak_mut`, produces `MUTABLE_REFERENCE_RETURNED`
- **testnet** — synthetic `oracle::update_price` + `oracle::swap`, produces `ORACLE_MANIPULATION_SUSPECTED`
- **testnet** — synthetic `gift::give` to a non-participant, produces `UNEXPECTED_TRANSFER`
- **testnet** — synthetic `hop::first -> hop::second -> hop::first`, produces `REENTRANCY_PATTERN`

The four testnet cases come from a package in `test-cases/synthetic-leak/`.
Testnet is wiped periodically, so those digests may eventually stop
resolving. Re-publish the package and update `known-txs.json` when that
happens.

```bash
cd test-cases/synthetic-leak
sui client switch --env testnet
sui move build
sui client publish --gas-budget 100000000
```

## Known limitations

- **Retention window.** Public fullnodes prune historical transactions.
  Anything older than roughly 21 days returns `NOT_FOUND`. The archival
  fallback hits `archive.mainnet.sui.io`, but that endpoint requires an
  `X-Token` header for authenticated access. For historical analysis at
  scale, use a provider like Triton or Quicknode, or run your own archival
  node.

- **`balanceChanges` is address-scoped.** Shared-object balance changes
  appear as `effects.changedObjects` mutations, not as address deltas. This
  is the root cause of most fires from `address-balance-delta`, which is why
  it's rated low severity and includes an explanatory note in its evidence.

- **`repeated-module-calls` threshold is tuned high.** Set to 5 calls per
  module to avoid firing on every DeFi aggregator PTB.

- **System transactions are skipped.** Transactions with sender
  `0x0000...0000` don't have programmable bodies and aren't returned by
  `GetTransaction`. The watcher catches this and skips silently.

- **`getMoveFunction` is one RPC call per unique signature.** Cached on
  disk, but a very large PTB touching many unfamiliar packages can exhaust
  the retry budget against a public fullnode.

- **`oracle-pattern`, `flash-loan-shaped`, and `capability-transfer` are
  name-based.** Legitimate protocols that match the keyword patterns will
  trip these. Treat as triage signals, not verdicts.

- **`ownership-anomaly` produces no signal on shared-object flows.** The
  recipient must be an address owner for the check to fire.

- **No testnet archival.** The archival fallback is mainnet-only. Testnet
  wipes periodically.

- **`chase_analyze` in the MCP server mutates `SUI_NETWORK` in
  `process.env`**, so concurrent calls with different networks would race.
  Claude Code and other clients serialize calls, so this doesn't bite in
  practice.

## Roadmap

- [ ] Positive test fixtures for `flash-loan-shaped` and `capability-transfer`
- [ ] Reconstruct object-owned balances to reduce `address-balance-delta` noise
- [ ] Archival endpoint token support (`ARCHIVE_TOKEN` env var)
- [ ] MCP server: refactor `runAnalysis` to take network as a parameter instead of reading `SUI_NETWORK` from env
- [ ] Persist checkpoint cursor across watch runs
- [ ] Additional invariants: dynamic field abuse, event-less state changes
- [ ] Publish to npm so `npx` works without a git clone

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

The `mutable-access` invariant is inspired by OpenZeppelin's published audit
findings on Sui Move visibility bugs. The `oracle-pattern` heuristic is
modelled on publicly documented Sui DeFi incidents.

## License

MIT. See [LICENSE](LICENSE).
