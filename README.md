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
npm install -g @zeroxcyril/chase
chase analyze <TX_DIGEST>
```

No global install wanted:

```bash
npx -y @zeroxcyril/chase analyze <TX_DIGEST>          # default `chase` bin
npx -y -p @zeroxcyril/chase chase triage <TX_DIGEST>  # any subcommand
npx -y -p @zeroxcyril/chase chase-mcp                 # the MCP server
```

For development (source checkout, runs through `tsx`):

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

Endpoints default to the public Sui gRPC fullnodes
(`https://fullnode.<network>.sui.io:443`) and need no configuration.
`SUI_RPC_URL` and `SUI_ARCHIVE_URL` override them for a provider or your own
node — https only, refused at startup rather than failing per transaction —
which is the way to analyse history beyond the public retention window.

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

A watch run remembers where it got to. The position lives at
`$XDG_DATA_HOME/chase/watch-cursor.json`, per network, and the first line it prints names which of
the four cases you are in: `STARTING FROM --from`, `RESUMING FROM SAVED CURSOR`,
`TIP-2 (no usable cursor)`, or `CURSOR UNUSABLE` followed by an exit. The stored number is the next
checkpoint to attempt, so a resumed run does not re-scan what was already covered, and checkpoints
whose listing failed are kept as a `gaps` list rather than quietly absorbed into coverage — the
closing line repeats them, and `Ctrl-C` now prints that line too before exiting 130.

Three deliberate refusals:

- A `--from` run does **not** rewind the stored cursor, and says so.
- A stored cursor below the endpoint's retention floor exits instead of clamping forward. Clamping
  would turn "resume" into an unasked-for backfill over weeks of history, and printing a number is
  not consent. The message gives both remedies.
- Set `CHASE_WATCH_CURSOR_FILE=''` to disable reading and writing entirely; the run then says it
  started at tip-2 because there was no cursor, which is a different statement from resuming.

It is not under `CHASE_CACHE_DIR` on purpose — the fixture suites point that variable at
`test-cases/fixtures`, and mutable state must not live where the tests read it.

Cache management:

```bash
npm run cache -- --dir
npm run cache -- --clear
npm run cache                # show signature count
```

Exit code is `0` when no violations, `1` when at least one fires, `2` on error.

### Library

```typescript
import { runAnalysis, triage, scout, allInvariants } from "@zeroxcyril/chase";

const report = await runAnalysis(digest, false, true);
console.log(report.violations);
```

The library entry point is `src/exports.ts` (`dist/exports.js` after a build).
Import that, not `dist/index.js`: the CLI entry parses `process.argv` when it
is loaded, so importing it from a program changes what that program thinks it
was asked to do.

### MCP server

Chase exposes six tools over the Model Context Protocol:

- `chase_analyze` - fetch a trace and run invariants on a digest
- `chase_query` - report signature cache state and cache directory
- `chase_watch` - bounded checkpoint range scan with optional filter
- `chase_triage` - run the triage layer over one or more digests
- `chase_list` - list digests in a checkpoint range; with `target` + `inspect` it
  verifies whether a package was actually involved, and reports how much of the
  range it did *not* look at
- `chase_hunt` - run the scout end to end under an explicit budget, returning
  coverage alongside findings

Run it:

```bash
npm run mcp                                  # from a source checkout
npx -y -p @zeroxcyril/chase chase-mcp        # anywhere
```

**Claude Code:**

```bash
claude mcp add --transport stdio --scope user chase -- npx -y -p @zeroxcyril/chase chase-mcp
claude mcp list
```

**Codex CLI:**

```bash
codex mcp add chase -- npx -y -p @zeroxcyril/chase chase-mcp
codex mcp list
```

**MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector npx -y -p @zeroxcyril/chase chase-mcp
```

The server speaks MCP protocol version 2025-06-18 over stdio. From a source
checkout, substitute `npx tsx src/mcp-server.ts` for the `npx -p` form in any of
the commands above.

### As an agent skill

`skill/chase/` packages Chase as a skill in the format used by
[pashov/skills](https://github.com/pashov/skills): `SKILL.md` for the agent (tools, workflow, how to read
coverage honestly, known limits), `README.md` for humans, and `references/` holding two real hunt
reports — one that found signals on routed Cetus volume, and the empty scan from before the target
matcher was fixed.

## Invariants

Chase ships with eleven invariant checks. Each is intentionally conservative:
they fire on patterns worth a human looking at, not on confirmed exploits.

All ten have a fixture that asserts the detector fires: synthetic Move packages
published to testnet that trigger each detector on demand. The two balance
checks (`address-balance-delta`, `coin-net-imbalance`) have no clean synthetic
trigger because the false-positive class is inherent to how gRPC surfaces
balance changes — they are asserted against an organic mainnet transaction
instead, which is a characterisation fixture, not proof that the detector
catches an exploit.

### address-balance-delta

Flags coin types where an address has a negative net balance change within a
transaction. Most fires are benign: when a coin flows into a shared object,
the recipient side doesn't appear in the address-based `balanceChanges`
array, so the sender's debit looks unmatched.

**Severity:** low

A real positive would show a coin type where the total address-based net
across all participants is nonzero and no shared object received the missing
amount. That second half — object-owned balances — is not in the trace, so
this check cannot distinguish the two on its own. It fires on 122 of 6,502
sampled mainnet transactions (1.9%), and the summed view of the same data is
the companion check below.

### coin-net-imbalance

Sums every `balanceChanges` row for a coin type across all addresses in the
transaction and reports a non-zero total: value entered or left the set of
addresses the trace can see.

**Severity:** low

**Measured:** fires on 189 of 6,502 mainnet transactions (2.9%), across 38
coin types. Excluding `0x2::sui::SUI` is load-bearing, not taste — with gas
counted the same rule fires on 71.6% of traffic, and 4,466 of those fires are
gas alone. It joins the swap-shape cluster in the corroboration table — paired against
`address-balance-delta` (same array, summed vs per address),
`reentrancy-pattern`, `repeated-module-calls` and `flash-loan-shaped`. That
was not a guess: shipping it with only the `address-balance-delta` pair moved
4 transactions from P3 to P2 on this corpus, because the imbalance is produced
by the very routing that trips those three. One swap shape, five ways of
noticing it.

**What this is not:** a supply-change check. The top functions attached to the
net-negative totals are `lending_market::claim_rewards_and_deposit`,
`gateway::provide_liquidity_with_fixed_amount` and `pool::open_position` —
deposits into shared objects whose internal balances this trace does not
carry. The finding therefore names the candidate mechanism (the transaction's
non-framework calls, in order) rather than claiming a leak, and the committed
fixture is a Kriya swap where 1,934,833,427 `CERT` left the address-visible
set with no receiving address.

### dynamic-field-lifecycle

Reports `0x2::dynamic_field::Field<K, V>` objects that a transaction **creates** or **deletes**,
with the key and value types parsed out of the type string and the parent object named when the
trace recorded an `ObjectOwner`.

**Severity:** low

**Measured:** 128 transactions (1.97%) create at least one field, 58 (0.89%) destroy one, 16 do
both. Deliberately **no mutation rule**: 3,807 transactions (58.55%) touch a field object and
14,497 of 14,816 field changes are mutations, so "a field was written" describes most of the chain
and means nothing. Saying so beats omitting it silently.

**What this is not:** the field's *key* — which field was added or removed — is not in the trace,
and neither is the parent when the object is not owned by another object. Those are named in the
evidence as unrecorded rather than guessed. A created or deleted field is a state change with a
legitimate routine explanation in most cases; the finding exists so a human can ask which one.

### silent-object-change

Reports a sender-held object that this transaction mutated or destroyed while **no event in the
transaction came from the package that owns the object's type** — checked against both positions Sui
reports, the event type and the event `packageId`, because the latter carries the *updated* package.

**Severity:** low, `corroborates: false`, and a `-20` modifier: alone it lands at NOISE/0.

**Measured:** 38 transactions (0.58%). The obvious rule is the one this is not. "The transaction
emitted no events" fires on **588 transactions (9.04%)** with 2,266 object changes behind them, and
**39% of all mainnet traffic emits nothing at all**, so silence is ordinary behaviour, not a
deviation — and that shape fires on six of this repo's own nine synthetic fixtures, because the test
package does not emit. A detector like that does not find anything; it raises tiers.

What it says instead of nothing: the report carries `silentObjectChanges` and prints a note when the
transaction changed typed non-framework objects without emitting a single event. That is stated as an
observation with its corpus rate attached, because a clean report on a silent transaction should not
read as a survey of an announceful one.

The population that does fire is dominated by capability-*shaped* types on order books —
`balance_manager::TradeCap`, `price_oracle::PriceFeederCap`, `authority::AuthorityCap`,
`market::OrderCap`. "Capability-shaped" is deliberate: `capability-transfer` matches none of those
names, and this check claims nothing about what they are. A silent update may be an intentional
design choice; the finding says where to look, not what was wrong.

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

The output owner's kind is recorded when the trace is fetched, so a second,
cached analysis answers the same question the first one did — and when an
object owns the object, the finding names the owning object instead of
apologising. Traces cached before that capture existed report
`recipientKind: "unrecorded"` and say to re-analyze with `--no-cache`, which
is a different claim from `unresolved` (the owner was read and could not be
classified — normally a deleted object, which has no output owner).

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

Flags PTBs that call a function matching borrow/flash keywords, followed by a DeFi action (swap,
liquidate, arbitrage), followed by a function matching repay/return keywords.

**Severity:** medium

**Verified:** fires on testnet digest
`8s8NfTFMpNKUWW18RK3zZ76zSEGn7EKC4DcbT5B9UEMm`. Synthetic source in
`test-cases/synthetic-leak/sources/flash.move`.

**Limitation:** name-based. Legitimate protocols that match the borrow/
action/repay keyword sequence will trip this. Treat as a triage signal. It also needs an action
*between* the borrow and the repay, so a bare `flash_swap` → `repay_flash_swap` pair with no
 intervening swap does not fire — asserted in the offline suite.

**A gap this detector had, and what closing it cost.** The borrow list omitted `flash_swap`, which is
Cetus's borrow-side entry point (`flash_swap` … `repay_flash_swap`), so that idiom read as three
unrelated calls. It was found by reading an escalated transaction on live mainnet traffic — the
investigator listed `pool::flash_swap` at cmd[11] while `FLASH_LOAN_SHAPED` stayed silent. Measured
over the 6,502 cached mainnet traces (`node scripts/corpus-report.mjs`, offline, no RPC):

| | before | after |
|---|---|---|
| `FLASH_LOAN_SHAPED` findings | 90 | 154 |
| transactions with any finding | 652 (10.0%) | 707 (10.9%) |
| high-severity findings | 16 | 16 |
| worst tier per transaction | P1=4 P3=277 NOISE=371 | P1=4 P3=335 NOISE=371 |

Every added fire landed at P3. The manual-review queue did not move, which is the trade worth
making: a pattern that was invisible is now visible at the lowest useful tier.

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

Every finding carries a `classification` block saying how much of *that*
transaction was visible: unresolvable object types, capability moves with no
resolvable owner, and `unrecordedOwnerKinds` for traces cached before owners
were captured.

Capability names are a fixed list, so a protocol that calls its cap `OrderCap`
is not matched. A `*Cap` suffix rule was measured against the 6,502-transaction
corpus before deciding: 416 object changes across 414 transactions carry a
cap-shaped type the list misses, and none of them was transferred to a
different address or left the sender's ownership — the widening would have
added no finding on that corpus, so it is coverage that cannot be priced, and
it is not taken.

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

Corroboration counts **independent** detectors only. A flash swap is
`borrow → action → repay`, calls one pool module repeatedly, and reads as re-entry at its own
entry/exit — so `FLASH_LOAN_SHAPED`, `REPEATED_MODULE_CALLS` and `REENTRANCY_PATTERN` are three names
for one construct, and `enrich.ts` treats them as an expected overlap rather than letting them boost
each other. That rule came out of a live run, not a hunch: over 308 mainnet transactions the only two
findings that reached P2 were Cetus flash swaps scoring "+25 corroboration (3 independent detectors)",
and on the same traffic the fix moved them to P3 (top score 50 → 35) without hiding anything — see
`reports/field-test-2026-09-29.md`.

A second case, decided differently: `DYNAMIC_FIELD_CREATED` fires on 2% of mainnet transactions and
is not a second opinion about anything — but it is genuinely orthogonal to a routing pattern, so
declaring it an "expected overlap" would have been a lie about the construct. Detectors therefore
declare `corroborates: false` on an emission, which means *reported, never used to raise priority*.
Without that mechanism, shipping the dynamic-field check moved two already-P1 oracle transactions'
reentrancy findings from P3 to P2 on the strength of a field appearing. A report-only finding can
still be escalated by the stronger signals around it; the policy is asymmetric on purpose.

Weights are in `src/triage/triage.config.json`. The confidence modifier per
invariant reflects how reliable the invariant is:

| Invariant | Modifier | Reason |
|-----------|----------|--------|
| MUTABLE_REFERENCE_RETURNED | +20 | Verified, deterministic |
| CAPABILITY_TRANSFER | +10 | Verified, high signal |
| UNEXPECTED_TRANSFER | +5 | Verified, has shared-object limitation |
| REENTRANCY_PATTERN | -10 | Verified but fires on DEX routers |
| COIN_NET_IMBALANCE | 0 | Aggregated view of the same array; low severity keeps it out of P2 alone |
| DYNAMIC_FIELD_CREATED | 0 | report-only: fires on 2% of traffic, so it must not raise priority |
| DYNAMIC_FIELD_DELETED | 0 | report-only: same, 0.9% of traffic |
| UNANNOUNCED_OBJECT_CHANGE | -20 | report-only: an absence, and silence is 39% of traffic |
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

A mandate is `{target, checkpoints, goal, budget}` — optionally with `txs`, an
explicit digest list — and `budget: {maxRpcCalls, maxLlmCalls, maxLlmTokens,
maxWallMs, reserveForJudge?}`. The budget is
enforced, not advisory: exceeding any limit raises `BudgetExceeded` and the
run stops with exit code `3`.

The scan does not spend all of it. By default 20% of `maxRpcCalls` (floor 4,
capped at half) is held back for triage and escalation, so findings come back
judged instead of blank — a hunt that burned its last call on one more
transaction used to return violations with no tier at all. Set it explicitly
with `budget.reserveForJudge` in the mandate or `--reserve-judge <n>`; `0` means
no reserve. The run says when it stops for that reason:

```
[scout] stopping pass: 8 rpc left, 8 held back for judgement
```

And the summary states how much of the target it actually reached, rather than
letting a thin sample read as a clean bill of health:

```
No violations in the 2 transaction(s) that reached 0x1eabed…; 52 inspected did not involve it.
```

### Pointing the scout at known transactions

`--txs <file>` (or `txs` in a mandate) analyzes exactly the listed digests:
one pass, no checkpoint sweep, and deliberately no target match — re-filtering a
list the caller already chose would drop the very transactions they asked
about, and a dropped digest reads as "analyzed, nothing found". This is the
path for "look at these eight transactions", and the only way to drive the
escalation branch deterministically.

```bash
chase hunt --txs digests.txt --network testnet     # one digest per line, # for comments
```

Real output from seven synthetic positive controls, verbatim except where
marked. Note that the coverage line claims no range it did not read, and that
P3 is left uninvestigated on purpose:

```
Scope:    7 explicit transaction(s), 1 pass (no checkpoint sweep)
Covered:  seq n/a-n/a (0 wide) | 7 listed | 7 analyzed | 0 no target call | 0 system | 0 repeat
Coverage: complete — every named transaction reached (no checkpoint sweep was performed)
Findings: 7
  9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg [P0] -> ESCALATE
      investigator: suspicious — MUTABLE_REFERENCE_RETURNED (rules layer, not a model)
        read: 1 cmds, 1 pkgs, top 0x101721… ×1, reverted, movement 0x4e7a16… -1023104 sui::SUI | MUTABLE_REFERENCE_RETURNED [0x101721…::leak::leak_mut]
        Signals that do not rest on a function name: MUTABLE_REFERENCE_RETURNED. Name-matched alongside them: none. Check the evidence line against the transaction before acting on this.
      HIGH MUTABLE_REFERENCE_RETURNED — 0x1017…::leak::leak_mut returns a mutable reference to the calling transaction; no other non-framework package is invoked in this PTB
  AyBucbogeLhR895L5SDyYucPwsA3gJLcmNn84krjiGEV [P1] -> MANUAL_REVIEW
      investigator: suspicious — CAPABILITY_TRANSFER (rules layer, not a model)
        read: 1 cmds, 1 pkgs, top 0xc28860… ×1, succeeded, movement 0x4e7a16… -1026752 sui::SUI, 1 transfer(s) | CAPABILITY_TRANSFER [coin::TreasuryCap<0xc28860daa55e…]
        … (reasoning elided)
      HIGH CAPABILITY_TRANSFER — TreasuryCap transferred to 0x0000000000…
  7Y3T5H7oXRhG1vjhnAERiseYW6tY4XndAfHSrrbVwKT2 [P2] -> MANUAL_REVIEW
      investigator: needs-review — name match only (rules layer, not a model)
        read: 2 cmds, 1 pkgs, top 0xe202f2… ×2, succeeded, movement 0x4e7a16… -1036936 sui::SUI | ORACLE_MANIPULATION_SUSPECTED [0xe202f2…::oracle::update_price, 0xe202f2…::oracle::swap]
        Every high-severity signal here fired on a function name: ORACLE_MANIPULATION_SUSPECTED. A name match is not a state change — read the left-hand function of each pair to check whether it writes a value the right-hand call consumes. Nothing here is evidence either way.
  GoZD6MFDHs6b8u8WLtc7V74iSjwrS2XztXiqPyvPYzzd [P3] -> MANUAL_REVIEW
      MEDIUM REENTRANCY_PATTERN — hop::first re-entered at cmd[2] after call to hop::second
  … (3 further findings — 2 at P3, 1 at NOISE — elided)
```

The escalation threshold is P0–P2. A report that investigated everything would
say nothing about which findings it thought mattered — so the `P3` above is
tiered and deliberately left unread.

### What an investigation adds

Triage scores a transaction by counting violations. An investigation reads one:
a trace fetch, then the calls in order, the packages involved, the largest coin
movement, what changed hands, and — the part that settles arguments — the exact
names each high-severity signal fired on. Identical firings collapse into one
counted signal, because a 28-command PTB that trips the oracle heuristic three
times on the same pair of functions has one fact to report, not three.

The verdict comes from the decision layer, and the layer is always named:
`(rules layer, not a model)`, `(read by <model>)`, or
`[DEGRADED: not a model reading]`. The deterministic layer is not allowed to
sound like a judgement it cannot make, so where every high-severity signal came
from a function-name match — the documented false-positive surface, and what
most organic escalations turn out to be — it answers `needs-review` and names
what to read next, instead of calling a transaction suspicious because its tier
said so.

Asked of a model over the same evidence, the reading is a different kind of
sentence. From a live mainnet transaction the rules layer had deferred:

```
investigator: suspicious — oracle price update followed by flash swap and repayment (read by poolside/laguna-s-2.1:free)
  read: 29 cmds, 5 pkgs, top 0x000000… ×10, succeeded, movement 0xd2c6e3… -4199388 sui::SUI | ORACLE_MANIPULATION_SUSPECTED×3 [0xe48b33…::alpha_lending::update_price, 0x25ebb9…::pool::flash_swap]
  The transaction calls alpha_lending::update_price at cmd[4], cmd[7], and cmd[10], each
  immediately followed by oracle::get_price_info and type_name::get, then executes
  pool::flash_swap at cmd[11] and cmd[14], with pool::repay_flash_swap at cmd[17] and cmd[27].
  … (the sentence continues; it runs to four)
```

Two things follow from that pair. The layers can disagree on identical evidence,
which is exactly why the source is printed; and a model's sentence is a
hypothesis about commands it can see, not a verdict on code it cannot — the
evidence contains no function signatures and no arguments, so *who controls the
price* remains unanswered. What that reading did contribute was the missing
pattern: `pool::flash_swap` sitting in the evidence while `FLASH_LOAN_SHAPED`
stayed silent, which is how the borrow keyword list came to be fixed
(see [flash-loan-shaped](#flash-loan-shaped)).

`--mode` picks the decision layer and defaults to `rules`, so a hunt is
reproducible with no API key and no spend. `--mode real` asks the configured
LLM; `--mode stub` is for tests. Whatever answers, the report keeps saying
which it was: a fallback decision prints
`[DEGRADED: not a model decision]`, and a fallback summary prints
`(generated by the fallback, not by the model)`.

The scan deliberately stops short of its own budget. Findings are only useful
once triaged, and triage costs one call per finding with one more read for each
that escalates, so the loop reserves calls for what it has already found instead
of spending the last call on one more transaction. An untiered finding is a worse
result than a shorter scan, and the run says so when it stops for that reason:

```
[scout] stopping pass: 9 rpc left, 11 held back for judgement of 5 finding(s)
[scout] iteration 1: 5 findings from 5/7 txs (range unread)
```

That run's report then says `Coverage: INCOMPLETE — 2 of 7 listed txs not
reached`, and the two transactions it never got to are named rather than absent.

Coverage is reported rather than assumed. Four kinds of "nothing" are kept
apart: no pass ran at all (`NO SCAN RAN` / `NOTHING SCANNED` — a dry-run or an
exhausted budget is not a result about the target); the range held no
transactions; the range held transactions but none matched the target
(`EMPTY AGAINST THE TARGET, not a clean scan`); or the target was reached and
stayed clean. A `--dry-run` used to print `Coverage: complete` because it had
listed zero transactions and reached all of them — technically true, and the
kind of sentence that gets read as a clean sweep.

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

- Normalized traces at `~/.cache/chase/<network>/<digest>.json`, stamped with
  the schema they were written under
- Move function signatures at `~/.cache/chase/signatures.json`

Repeat analyses of the same digest are near-instant and avoid hitting the
public fullnode. Signature resolution is skipped entirely for functions
already cached. Traces are namespaced by network, because the same digest
requested on two networks must never resolve to one record.

```bash
npm run cache -- --dir      # print cache location
npm run cache -- --clear    # wipe traces and signatures
npm run cache                # show signature count
```

`--clear` also sweeps files the cache no longer reads: traces written at the
cache root before namespacing existed, and checkpoint listings. Both used to
survive a wipe that reported itself complete.

Override the cache directory with `CHASE_CACHE_DIR`. Bypass trace cache with
`--no-cache`.

## Testing

Fixtures live in `test-cases/known-txs.json`. Run the suite:

```bash
./scripts/run-tests.sh
./scripts/run-triage-tests.sh
npm run test:agent        # target matching, budget reserve, investigator (reading,
                          # evidence and provenance), detector keyword shapes, batch
                          # shape, CLI validation, dry-run coverage, manifest/lock
                          # agreement, endpoint configuration
npx tsx scripts/test-budget.ts   # Budget unit checks (rpc/llm/token/time)
```

```bash
npm test                  # all four suites
```

All four read committed fixtures or need no network at all, so a fresh clone with
no `.env` passes offline — which also means none of them can tell you whether the
transport still answers.
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

Detection quality is measured, not asserted, and the measurement is offline:

```bash
node scripts/corpus-report.mjs after   # over whatever is in the trace cache
```

It runs the full invariant + triage pipeline over every trace in the local cache
(`~/.cache/chase/<network>`), with history disabled so two runs are comparable, and
prints the flag rate, the worst tier per transaction, and the per-type breakdown. No
RPC, and it repeats exactly. This is how a detector change gets priced: adding
`flash_swap` to the borrow keywords moved `FLASH_LOAN_SHAPED` from 90 to 154 findings
and the flag rate from 10.0% to 10.9% across 6,502 cached mainnet transactions, while
high-severity findings stayed at 16 and the P1 count stayed at 4 — every added fire
landed at P3.

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

- **Retention window, and the archival fallback does not rescue it.** Public
  fullnodes prune historical transactions; anything older than roughly 21 days
  returns `not found`. Chase then tries
  `archive.mainnet.sui.io` — measured 2026-09-29, that endpoint is reachable
  without any token, but it also returns `not found` for digests the fullnode
  has pruned, including two of this repo's own mainnet fixtures. So the
  fallback is attempted and does not recover history; the error now says so
  instead of reporting a bare second miss. Two of the nine fixtures can only be
  re-analysed because their traces are committed. The fix is an endpoint that
  keeps history: point `SUI_ARCHIVE_URL` at a provider archive (Triton,
  Quicknode) or your own archival node, and pruned digests resolve. A failure
  on the way there is now named — an empty-message gRPC error used to print
  `RpcError` and nothing else, which is how nine transactions vanished
  unexplained in a 1,106-tx run; it now reports
  `gRPC RpcError <code> — <details> while reading <digest>`.

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

- **An investigation sees commands, not code.** The evidence it reads is the
  normalized trace: call order, packages, balances, object changes, events, and
  the names detectors matched. It has no function signatures and no call
  arguments, so the question that usually decides a case — who can call this, and
  what does it write — is answered by reading the Move source, not by Chase. The
  deterministic layer therefore returns `needs-review` when a high-severity signal
  rests on a name alone, and a model's `suspicious` on the same evidence is a
  hypothesis with a named next read, not a finding. Both are labelled with the
  layer that answered.

- **`ownership-anomaly` produces no signal on shared-object flows.** The
  recipient must be an address owner for the check to fire.

- **The offline watch-loop test drives a fake listing.** `chase watch` had no automated coverage at
  all before the cursor landed, because its fixture path needs checkpoint listings rather than just
  traces and a live listing cannot be committed. What the test proves is the loop's bookkeeping —
  which checkpoint the cursor advanced past, what a failed listing did to the gap ledger, and what
  the run printed. It does **not** prove that a real checkpoint listing behaves like the fake one;
  `npm run smoke:live` and `chase watch --limit 1` against a live node are what cover that.

- **Traces cached before schema 2 have no recorded owner.** Both ownership
  rules then report `unrecorded` rather than a kind, because a lookup that
  never happened is not the same statement as one that failed. `--no-cache`
  on the digest resolves it; the cache is not rewritten in place.

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
- [x] Configurable RPC endpoints — `SUI_RPC_URL` / `SUI_ARCHIVE_URL` (0.1.4), so
      a Triton, Quicknode or self-run archive can be used for historical
      analysis. The public archive endpoint is reachable without a token but
      does not hold pruned digests, so a token would not have fixed the
      retention gap; an override is what does.
- [ ] Persist checkpoint cursor across watch runs
- [ ] Additional invariants: dynamic field abuse, event-less state changes
- [x] Publish to npm — `@zeroxcyril/chase`, installable and runnable via `npx`
      without a git clone
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
