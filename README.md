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

Chase is a **dynamic analysis** tool. It reasons about what a transaction
actually did on-chain, not what a contract's source code looks like. This is
complementary to static analysis and formal verification, and it catches
classes of issues (unexpected state changes, unexpected transfers, suspicious
call sequences) that source-level tools often miss.

## Where it fits

The Sui/Move tools currently listed in the [AI web3 security
hub](https://github.com/pashov/ai-web3-security) describe themselves as source-level auditors and audit
skills. Chase reasons about **execution**, after deployment — the phase they cannot see.

| Phase | Tool | Question it answers |
|---|---|---|
| Pre-deployment | static Move auditors | what could this contract do? |
| Post-deployment | **Chase** | what did this transaction actually do? |
| Continuous | **Chase scout** | is anything happening to this package right now? |

Reverted transactions are analysed too. An attempted exploit usually fails,
and the attempted call is still worth inspecting — which is exactly the
evidence a source-level audit never sees.

Three layers, each independently callable, each usable by a human or an agent:
deterministic invariants → deterministic triage (score, tier, recommended
action) → an optional reasoning layer. The model explains and prioritises; it
does not decide what fired.

What that produces, from two live mainnet runs — the point is that the second
one is *dismissed*, not that both fired:

```
Findings: 1
  HmPWB9PAA1toN5zjz5FCshkgYwwh5xxrTCxAQYEnntur [NOISE] -> DISMISS
      LOW ADDRESS_OUTFLOW — 0xd2bc4f53e6… net outflow of -282436834 SUIPUMP
```

```
   P0  MUTABLE_REFERENCE_RETURNED  score=80
  0x10172126bb0bc55e32dea70a223b7590da2eecf6a1b40bb2c353f1d750f12405::leak::leak_mut
    returns a mutable reference to the calling transaction; no other non-framework
    package is invoked in this PTB
  rationale: MUTABLE_REFERENCE_RETURNED (high) base=60 · +20 confidence · = 80
  action: ESCALATE
```

The `rationale` line is the arithmetic, not an opinion — every tier can be
traced back to the weights in `src/triage/triage.config.json`.

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

`npm install` runs the build through `prepare`, and `dist/` is what the
`chase`, `chase-triage`, `chase-hunt` and `chase-mcp` bins execute.

Nothing in `.env` is required to analyze a transaction — the default is
mainnet with no configuration at all. `SUI_NETWORK` changes that default, and
`LLM_API_KEY` / `LLM_ENDPOINT` / `LLM_MODEL` are read only by
`chase triage --explain` and `chase hunt --mode real`.

Endpoints are not configurable: Chase speaks gRPC to
`https://fullnode.<network>.sui.io:443`, with `archive.mainnet.sui.io` as the
mainnet fallback for pruned digests.

## Usage

### CLI

Six commands: `analyze`, `batch`, `watch`, `cache`, `triage`, `hunt`. The
examples below run from a source checkout via `npm run`; after `npm run build`
the same surface is one binary — `node dist/index.js <command>`, or
`chase <command>` once the package is linked (`npm link`). `chase-triage`,
`chase-hunt` and `chase-mcp` stay available as standalone aliases of their
subcommands.

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
import { runAnalysis, triage, scout, allInvariants } from "@0xcyrildev/chase";

const report = await runAnalysis(digest, false, true);
console.log(report.violations);
```

The library entry point is `src/exports.ts` (`dist/exports.js` after a build).
Import that, not `dist/index.js`: the CLI entry parses `process.argv` when it
is loaded, so importing it from a program changes what that program thinks it
was asked to do.

### MCP server

Chase exposes four tools over the Model Context Protocol:

- `chase_analyze` - fetch a trace and run invariants on a digest
- `chase_query` - report signature cache state and cache directory
- `chase_watch` - bounded checkpoint range scan with optional filter
- `chase_triage` - run the triage layer over one or more digests

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

### As an agent skill

`skill/chase/` packages Chase as a skill in the format used by
[pashov/skills](https://github.com/pashov/skills): `SKILL.md` for the agent (tools, workflow, how to read
coverage honestly, known limits), `README.md` for humans, and `references/` holding two real hunt
reports — one that found signals on routed Cetus volume, and the empty scan from before the target
matcher was fixed.

## Invariants

Chase ships with eight invariant checks. Each is intentionally conservative:
they fire on patterns worth a human looking at, not on confirmed exploits.

Seven of the eight have **positive controls**: synthetic Move packages
published to testnet that trigger each detector on demand. The remaining one
(`address-balance-delta`) is a heuristic that fires on patterns without a
clean synthetic trigger, because the false-positive class is inherent to how
gRPC surfaces balance changes.

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

**Verified:** fires on testnet digest
`CFcSiiRgdsXU7Rb4SVjqEyBbx4yiFJWrASYcHcM56hx9`. Synthetic source in
`test-cases/synthetic-leak/sources/repeat.move`.

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

**Verified:** fires on testnet digest
`8s8NfTFMpNKUWW18RK3zZ76zSEGn7EKC4DcbT5B9UEMm`. Synthetic source in
`test-cases/synthetic-leak/sources/flash.move`.

**Limitation:** name-based. Legitimate protocols that match the borrow/
action/repay keyword sequence will trip this. Treat as a triage signal.

### capability-transfer

Flags transfers of capability objects (`TreasuryCap`, `AdminCap`,
`UpgradeCap`, `OwnerCap`, `MintCap`, `BurnCap`) to addresses other than the
transaction sender.

**Severity:** high

**Verified:** fires on testnet digest
`AyBucbogeLhR895L5SDyYucPwsA3gJLcmNn84krjiGEV`. Synthetic source in
`test-cases/synthetic-leak/sources/cap.move`.

**Limitation:** name-based on the object type string. A `TreasuryCap`
transfer also trips `ownership-anomaly`, which is expected - a cap moving to
a new owner is both an ownership change and a capability handoff.

## Triage

The triage layer sits on top of Chase's invariants and reduces noise. Chase
produces deterministic violations; the triage agent decides which ones
deserve attention.

```bash
npm run triage -- <DIGEST>
npm run triage -- <DIGEST> --json -o reports/triage.json
npm run triage -- <DIGEST> --explain
npm run triage -- <DIGEST> --min-tier P2
npm run triage -- batch.ndjson
npm run triage -- <DIGEST> --record
```

`--record` is the only path that writes the novelty history; without it a
triage run reads counters but changes none.

Triage accepts the `.ndjson` that `chase batch` writes. Digests that cannot
be analyzed do not abort the run: they are listed under `skipped`, each with
a reason, and the report says how many of the input it actually covered.
A batch file with one pruned transaction used to return nothing at all.

### Scoring

Each finding gets a priority score from 0 to 100, computed deterministically:

```
priority = base_severity + corroboration - benign_penalty - novelty_penalty + confidence_modifier
```

Weights are in `src/triage/triage.config.json`. The confidence modifier per
invariant reflects how reliable the invariant is:

| Invariant | Modifier | Reason |
|-----------|----------|--------|
| MUTABLE_REFERENCE_RETURNED | +20 | Verified, deterministic |
| CAPABILITY_TRANSFER | +10 | Verified, high signal |
| UNEXPECTED_TRANSFER | +5 | Verified, has shared-object limitation |
| REENTRANCY_PATTERN | -10 | Verified but fires on DEX routers |
| ORACLE_MANIPULATION_SUSPECTED | -15 | Name-based |
| FLASH_LOAN_SHAPED | -5 | Name-based |
| ADDRESS_OUTFLOW | -20 | Fires on shared-object inflows |
| REPEATED_MODULE_CALLS | -20 | Tuned threshold, framework-adjacent |

### Tiers

| Tier | Score | Meaning |
|------|-------|---------|
| P0 | 80+ | Escalate. Multiple high-confidence signals. |
| P1 | 60-79 | Manual review today. |
| P2 | 40-59 | Queue for review. |
| P3 | 20-39 | Log. Likely benign. |
| NOISE | <20 | Dismiss with rationale. |

### Benign patterns

`src/triage/benign-patterns.json` lists known-benign call patterns. When a
finding matches, it receives a penalty: -40 for exact matches, -20 for
heuristic (wildcard) matches. Edit the file to add your own.

Example suppression: `*::coin_utils::transfer_nonzero` - a common aggregator
helper that trips `REENTRANCY_PATTERN` on every multi-hop swap.

### LLM explanations

`--explain` sends all findings from one transaction to an LLM in a single
call. The LLM produces a paragraph per finding explaining what fired, why it
might be a false positive, and what action to take. The deterministic scoring
and tier assignment are unaffected by the LLM output - the LLM only writes
prose and may set `nextAction`.

The triage layer works without `--explain`. Scoring, tier assignment,
benign-pattern matching, and caveats generation are all offline.

Set `LLM_API_KEY` (and optionally `LLM_ENDPOINT`, `LLM_MODEL`) in `.env`. Any
OpenAI-compatible endpoint works, including OpenRouter's free tier. The scout
agent's `--mode real` reads the same three variables.

### Triage fixtures

`test-cases/known-txs.json` carries an `expectTiers` array per case.
`./scripts/run-triage-tests.sh` checks each fixture produces the expected
tier set. Runs offline, no LLM calls.

The suite ends with one inline case that no fixture can express: a batch file
holding an unresolvable digest next to a live one must report the live finding
*and* name the skipped digest. A triage report that quietly covered less than
its input is the failure that case guards.

## Hunt

The scout is a bounded loop, not an open-ended agent. A mandate says what to
watch and what "suspicious" means; a budget says when to stop.

```bash
npm run hunt -- --mandate mandates/cetus-mainnet.json
npm run hunt -- --target 0x1eabed... --checkpoints 20 --goal "oracle manipulation"
npm run hunt -- --mandate mandates/synthetic-testnet.json --dry-run
npm run hunt -- --mandate mandates/cetus-mainnet.json --mode real --md -o reports/hunt.md
```

A mandate is `{target, checkpoints, goal, budget}` with
`budget: {maxRpcCalls, maxLlmCalls, maxLlmTokens, maxWallMs}`. The budget is
enforced, not advisory: exceeding any limit raises `BudgetExceeded` and the
run stops with exit code `3`.

`--mode` picks the decision layer and defaults to `rules`, so a hunt is
reproducible with no API key and no spend. `--mode real` asks the configured
LLM; `--mode stub` is for tests. Whatever answers, the report keeps saying
which it was: a fallback decision prints
`[DEGRADED: not a model decision]`, and a fallback summary prints
`(generated by the fallback, not by the model)`.

The scan deliberately stops short of its own budget. Findings are only useful
once triaged, and an escalation costs the investigator another fetch, so the
loop reserves calls for what it has already found instead of spending the last
call on one more transaction. An untiered finding is a worse result than a
shorter scan, and the run says so when it stops for that reason:

```
[scout] stopping pass: 10 rpc left, 10 reserved for 3 finding(s)
```

Coverage is reported rather than assumed. Three kinds of "nothing" are kept
apart: the range held no transactions, the range held transactions but none
matched the target, or the target was reached and stayed clean. A run that
matched nothing prints `EMPTY AGAINST THE TARGET, not a clean scan`, because
absence of findings after an incomplete scan is not evidence of safety.

Target matching is done client-side, against the transaction's own trace —
call package, event type prefix, and object type prefix. The gRPC `moveCall`
filter is not used for this, because it under-matches: over one mainnet range
it returned rows for `0x2` while answering "nothing" for `0x2::transfer` and
for a Cetus package id that 8% of the sampled transactions demonstrably
swapped through. Routed volume names the router at the top level, and Sui
stamps events with the *updated* package id, so only the type strings carry
the original. Checking the trace costs no extra request and analyzes fewer
transactions, not more.

## Architecture

```
src/
├── index.ts                    # CLI entry; mounts all six commands
├── exports.ts                  # library entry point (the CLI parses argv on import)
├── mcp-server.ts               # MCP server (stdio transport)
├── commands/
│   ├── analyze.ts              # orchestrates fetch -> check -> report
│   ├── batch.ts                # NDJSON batch mode with concurrency
│   └── watch.ts                # checkpoint scanner
├── lib/
│   ├── banner.ts               # ASCII banner
│   ├── cache.ts                # on-disk trace cache
│   ├── concurrency.ts          # bounded parallel map
│   ├── digest.ts               # digest shape check (they become cache paths)
│   ├── fetcher.ts              # gRPC fetch + normalize + signature resolver
│   ├── reporter.ts             # human and JSON output
│   ├── sigcache.ts             # persisted signature cache
│   ├── types.ts                # shared interfaces
│   ├── undici-setup.ts         # global dispatcher: IPv4, 30s connect timeout
│   └── version.ts              # single version string
├── triage/
│   ├── cli.ts                  # chase-triage binary (thin wrapper)
│   ├── command.ts              # triage surface, shared by the binary and `chase triage`
│   ├── index.ts                # triage orchestrator
│   ├── enrich.ts               # cross-invariant correlation, benign lookup
│   ├── scoring.ts              # deterministic priority scoring
│   ├── explain.ts              # LLM explanation layer (batched)
│   ├── report.ts               # triage report emitter (pure: records nothing)
│   ├── benign.ts               # benign-pattern matcher
│   ├── benign-patterns.json    # user-editable suppression library
│   ├── history.ts              # per-network novelty counters (opt-in writes)
│   ├── triage.config.json      # scoring weights
│   └── types.ts                # triage types
├── agent/
│   ├── cli.ts                  # chase-hunt binary (thin wrapper)
│   ├── command.ts              # hunt surface, shared by the binary and `chase hunt`
│   ├── scout.ts                # the bounded scan loop
│   ├── investigator.ts         # P0-P2 escalation path
│   ├── mandate.ts              # mandate load/validate/build
│   ├── budget.ts               # hard limits; raises BudgetExceeded
│   ├── llm.ts                  # real-mode decisions (OpenAI-compatible)
│   ├── rules-llm.ts            # deterministic default mode
│   ├── stub-llm.ts             # fixed responses, for tests
│   ├── checkpoint-cache.ts     # cached checkpoint listings, 5-minute TTL
│   ├── report-md.ts            # markdown report + coverage caveats
│   └── types.ts                # mandate/report/decision types
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
./scripts/run-triage-tests.sh
```

Both suites read committed fixtures, so they are offline and deterministic —
which also means they cannot tell you whether the transport still answers.
For that:

```bash
npm run smoke:live                 # three live mainnet transactions, uncached
CHASE_SMOKE_TXS=2 npm run smoke:live testnet
```

`smoke:live` runs against `dist/`, lists the checkpoint two behind the tip,
analyzes up to three programmable transactions and exits non-zero if none
could be analyzed. It is the check that catches a retention-window change, a
gRPC shape break, or an endpoint that stopped responding — none of which a
fixture can see.

Nine cases:

- **mainnet** - clean order cancel, no violations
- **mainnet** - aggregator swap, produces `ADDRESS_OUTFLOW` and `REENTRANCY_PATTERN`
- **testnet** - synthetic `leak::leak_mut`, produces `MUTABLE_REFERENCE_RETURNED`
- **testnet** - synthetic `oracle::update_price` + `oracle::swap`, produces `ORACLE_MANIPULATION_SUSPECTED`
- **testnet** - synthetic `gift::give` to a non-participant, produces `UNEXPECTED_TRANSFER`
- **testnet** - synthetic `hop::first -> hop::second -> hop::first`, produces `REENTRANCY_PATTERN`
- **testnet** - synthetic `flash::flash_borrow -> flash::swap -> flash::flash_repay`, produces `FLASH_LOAN_SHAPED`
- **testnet** - synthetic `cap::give_cap` transferring `TreasuryCap` to a non-sender, produces `CAPABILITY_TRANSFER` and `UNEXPECTED_TRANSFER`
- **testnet** - synthetic `repeat::bump` called 5x, produces `REPEATED_MODULE_CALLS`

The seven testnet cases come from a package in `test-cases/synthetic-leak/`.
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

- **Listings are capped per request.** Measured on mainnet: one
  `listTransactions` call returns at most 500 transactions and reports
  `complete=false`. A wide `--checkpoints` range is therefore sampled from the
  start of the range rather than swept end to end. The hunt report says so —
  `a listing stopped before the checkpoint bound` plus `N of M listed txs not
  reached` — so spend the budget on repeated narrow ranges instead of one wide
  one, and read `INCOMPLETE` before reading `0 findings`.

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

- **Triage history is shared mutable state, and recording is opt-in.**
  Counters live at `$XDG_DATA_HOME/chase/triage-history.json` (default
  `~/.local/share/chase/triage-history.json`), namespaced per network so a
  testnet signature cannot age out a mainnet one. Nothing is recorded unless
  `chase triage --record` asks for it: the analysis path, the MCP tools and
  the scout stay read-only, because a run that ages its own findings
  silently decays its own signal. Novelty penalties kick in after 20
  occurrences. Set `CHASE_HISTORY_FILE=""` to disable the store entirely.

## Roadmap

- [ ] Reconstruct object-owned balances to reduce `address-balance-delta` noise
- [ ] Archival endpoint token support (`ARCHIVE_TOKEN` env var)
- [ ] Persist checkpoint cursor across watch runs
- [ ] Additional invariants: dynamic field abuse, event-less state changes
- [ ] Publish to npm so `npx` works without a git clone
- [ ] Scout agent: autonomous *target selection* (the scanning loop, budget and
      triage pass shipped; the target still comes from the mandate)

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
