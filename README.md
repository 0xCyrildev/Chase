# Chase

**Static analysis reasons about what a contract says. Chase reasons about what a transaction did.**
It is the post-deployment layer of a Sui Move security workflow, the phase a source audit cannot
observe, because by the time Chase runs the chain has already answered.

[![npm version](https://img.shields.io/npm/v/@zeroxcyril/chase.svg)](https://www.npmjs.com/package/@zeroxcyril/chase)
![test](https://github.com/0xCyrildev/Chase/actions/workflows/test.yml/badge.svg?branch=main)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

You give it a transaction digest, or a package to watch, and it reads the execution trace off a gRPC
fullnode and tells you what happened: which calls ran, in what order, what moved, what changed hands,
and which of eleven invariant checks thought that pattern was worth a human looking at.

It is one tool in four shapes: a CLI you can type, a library a script can import, an MCP server an
orchestrator can route into, and a packaged agent skill under [`skill/chase/`](#as-an-agent-skill),
which is the same three layers written for an agent to follow. Detection stays deterministic. A model
is only ever asked to read and explain what the checks already fired on, never to decide what fired.

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

## What it does, and what it does not do

For a given digest Chase fetches the full execution trace over gRPC, resolves the signature of every
MoveCall in the transaction block, normalizes the result into a shape that does not change between
releases, runs eleven invariant checks over it, and reports what fired with severity, evidence, and a
triage tier. Reverted transactions are analysed in full, because an exploit attempt usually fails at
some point and the attempted call is still the interesting part.

It does not read source, and that limit is the whole point rather than an omission. Static analysis asks
what a contract could do. Chase asks what a transaction did, after deployment, on a real chain, which is
the phase a source audit cannot observe.

| Phase | Tool | Question it answers |
|---|---|---|
| Before deployment | static Move auditors | what could this contract do? |
| After deployment | **Chase** | what did this transaction actually do? |
| Continuously | **Chase scout** | is anything happening to this package right now? |

Chase ships as a CLI, a library, an MCP server and an agent skill, so a human can run it, a script can
import it, an orchestrator can call it, and another agent can be handed the skill and know when to
reach for it. What it produces is a triage signal with an arithmetic trail, never a
verdict. A clean report means that one transaction did not do these things. It does not mean a package is
safe, and any report that lets you forget that is doing this project wrong.

## Install

```bash
npm install -g @zeroxcyril/chase
chase analyze <TX_DIGEST>
```

Nothing in a `.env` is required. The default network is mainnet, the public gRPC endpoint is used
directly, and no API key is read unless you ask for model reasoning.

Without a global install, which is the form a reviewer tends to try first:

```bash
npx -y @zeroxcyril/chase analyze <TX_DIGEST>          # resolves to the `chase` bin
npx -y -p @zeroxcyril/chase chase triage <TX_DIGEST>  # any subcommand, four bins installed
npx -y -p @zeroxcyril/chase chase-hunt --target <package_id> --mode rules
npx -y -p @zeroxcyril/chase chase-mcp                 # the MCP server
```

Both of those forms are run before this file is shipped, because one of them used to be a lie. Through
0.2.0 the bare `npx -y @zeroxcyril/chase …` form failed with `Permission denied`: `tsc` emits its bin
files at mode 0644, npm packs whatever modes it is handed, and npx execs the file straight out of its
cache. A global install was unaffected because npm sets the bit on the link it creates, so every previous
"installed the tarball into a clean prefix and ran all four bins" check was accurate about the one path
that was not broken. The build now marks the bins executable and a test asserts the modes.

For development from a checkout:

```bash
git clone https://github.com/0xCyrildev/Chase.git
cd Chase
npm install          # runs the build through `prepare`, which is what the bins execute
cp .env.example .env # optional, and nothing in it is needed to analyze a transaction
```

## First run

This is real output from a live mainnet transaction, an order cancellation that reverted, analyzed with
`chase analyze 2UkzDTPuKXLX3JeWKXR7eUvpBqCtdDGkCW7PHWwBrEk8`:

```
 CHASE - Transaction Analysis
Digest:  2UkzDTPuKXLX3JeWKXR7eUvpBqCtdDGkCW7PHWwBrEk8
Network: mainnet
Status:  failed
Sender:  0x246a7c59dffe45e63f0a81ac7b7893398d756f85cdd0b4e64cf63d2ea6cbb5fe
Time:    2026-09-30T09:11:33.943Z
Stats:   2 cmds | 1 balance changes | 4 object changes | 0 events
Note:    3 object change(s) in this transaction and no event emitted at all; stated rather than scored, because 39% of mainnet traffic is silent this way

⚠  1 violation(s) detected:

  [LOW] UNANNOUNCED_OBJECT_CHANGE
    balance_manager::TradeCap mutated with no event from balance_manager (the sender held it; now address)

    … the tool also prints the full evidence object here, with objectId, objectType,
      changeType, changedPackage, recipientKind, eventsInTx, eventPackages and a note
```

Two things are worth noticing in that. The transaction failed on chain and was still analysed, because a
reverted attempt is evidence. And the `Note:` line is an observation with a base rate attached to it, not
a finding: the tool says the transaction was silent, tells you that a third of all traffic is silent, and
then scores nothing for it.

That finding is also not a vulnerability. A `TradeCap` being mutated without its package emitting an
event is how a lot of order books work. What Chase is offering is a pointer with the reasoning attached,
so a human can decide whether to go read `balance_manager`.

## Where the numbers come from

Nothing in this file is an estimate of what the tool feels like. Rates are measured over a corpus of
cached mainnet traces by `npm run corpus`, which runs the real pipeline offline and prints the flag rate,
the worst tier per transaction and a per-type breakdown. The corpus grew during this release, from 6,502
traces to 6,576, because verifying the watch cursor means scanning real checkpoints, so every figure
below states the denominator it was measured against. The two escalations that pricing caught before
those detectors shipped are written up in `reports/0.2.0-detector-pricing.md` rather than quietly fixed.

The commands in the usage blocks below were run against this build, and the CI runs the same four suites
on every push.

## Usage

### CLI

Six commands: `analyze`, `batch`, `watch`, `cache`, `triage`, `hunt`. The examples run from a source
checkout through `npm run`. After `npm run build` the same surface is one binary, `node dist/index.js
<command>`, or `chase <command>` once the package is linked with `npm link`. `chase-triage`, `chase-hunt`
and `chase-mcp` remain available as standalone aliases of their subcommands.

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
npm run watch -- --from 328575000 --to 328575100      # a bounded range, then stop
npm run watch -- --status                             # where did it leave off? costs no RPC
npm run watch -- --reset-cursor -n testnet            # forget that network's position
```

A watch run remembers where it got to. The position lives at
`$XDG_DATA_HOME/chase/watch-cursor.json`, per network, and the first line it prints names which of
the four cases you are in: `STARTING FROM --from`, `RESUMING FROM SAVED CURSOR`,
`TIP-2 (no usable cursor)`, or `CURSOR UNUSABLE` followed by an exit. The stored number is the next
checkpoint to attempt, so a resumed run does not re-scan what was already covered, and checkpoints
whose listing failed are kept as a `gaps` list rather than quietly absorbed into coverage. The
closing line repeats them, and `Ctrl-C` now prints that line too before exiting 130.

`--to` ends a range where you say. Two things it will not do: it will not walk past the endpoint's
tip and record checkpoints that do not exist yet, because that advance would read as coverage the
chain never had, so a range that outruns the tip stops, names the part it could not scan, leaves the
cursor at the first unreadable-from-here checkpoint and exits 2. And it will not accept `--to` below
the checkpoint the run would start from, because a run that scans nothing while printing a tidy
summary is the one report format that lies. `--limit` cutting a range short is different: that is a
stop you asked for, so it exits 0 and says where the next run picks up.

The position itself is now inspectable without starting a scan. `--status` prints the file it read,
the next checkpoint, when it was saved and how many gaps are recorded, and makes no network call at
all, which matters because "where did the monitor get to?" should stay answerable while the endpoint
is down. `--reset-cursor` forgets one network's position and leaves the others alone. It prints what
it removed and the checkpoint you would have to pass to `--from` to get it back, because a reset you
cannot undo is a reset you will not run. Passing both flags at once is refused: one is a question
and the other is a deletion, and reading before deleting is the order that keeps the answer
available. A store this cannot parse is never deleted by a reset either, since the same file holds
the other networks' positions. `chase cache` prints the same state read-only, and `chase cache
--clear` explicitly does not touch it: wiping the traces means the next scan refetches, not that it
forgot where it had got to.

Three deliberate refusals:

- A `--from` run does **not** rewind the stored cursor, and says so.
- A stored cursor below the endpoint's retention floor exits instead of clamping forward. Clamping
  would turn "resume" into an unasked-for backfill over weeks of history, and printing a number is
  not consent. The message gives both remedies.
- Set `CHASE_WATCH_CURSOR_FILE=''` to disable reading and writing entirely; the run then says it
  started at tip-2 because there was no cursor, which is a different statement from resuming.

It is not under `CHASE_CACHE_DIR` on purpose: the fixture suites point that variable at
`test-cases/fixtures`, and mutable state must not live where the tests read it.

Cache management:

```bash
npm run cache -- --dir
npm run cache -- --clear
npm run cache                # signature count, and where each network's watch position lives
```

Exit code is `0` when no violations, `1` when at least one fires, `2` on error.

### Library

```typescript
import { runAnalysis, triage, scout, investigate, allInvariants } from "@zeroxcyril/chase";

const report = await runAnalysis(digest, false, true);
console.log(report.violations);
```

`investigate` is the reading layer on its own, because it is a layer rather than a detail of the scout:
`scout` decides what to read, `investigate` reads what you already named. It takes a triaged finding, one
`ask` callback (the decision layer you want to form the reading) and a network, and returns the evidence
with the verdict and its provenance attached. Same shape as the `chase_investigate` MCP tool, so a script,
an agent and the CLI reach one reading instead of three near-copies of it.

The library entry point is `src/exports.ts` (`dist/exports.js` after a build).
Import that, not `dist/index.js`: the CLI entry parses `process.argv` when it
is loaded, so importing it from a program changes what that program thinks it
was asked to do.

### MCP server

Chase exposes seven tools over the Model Context Protocol:

- `chase_analyze` - fetch a trace and run invariants on a digest
- `chase_query` - report signature cache state, the cache directory, and where `chase watch` left off
  on each network (read only; this call never moves a position)
- `chase_watch` - bounded checkpoint range scan with optional filter. Stateless: it neither reads nor
  writes the cursor the CLI command keeps, so nothing here advances what `chase watch --status` reports
- `chase_triage` - run the triage layer over one or more digests
- `chase_investigate` - read named digests the way the escalated path reads them: one trace fetch each,
  the commands in order, the packages by call count, the coin movements, what changed hands, the exact
  names each high-severity signal fired on, and the verdict asked of the layer you name. Every reading
  carries `source`, so a rules-table answer cannot be mistaken for a model's. Triage's tier comes back
  beside it, and a digest with nothing to read is returned under `notRead` with its reason rather than
  going missing. This is the investigator without the scout: it reads what you hand it and does not
  decide which transactions deserve reading
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

This README explains Chase to a reader. `skill/chase/` explains it to an agent, in the format used by
[pashov/skills](https://github.com/pashov/skills): `SKILL.md` with frontmatter and trigger phrases (when
to reach for dynamic analysis instead of a source audit, and which of the three layers to route into),
a `README.md` for the human reviewing the agent's work, and `references/` holding real hunt reports, one
that found signals on routed Cetus volume and one that found nothing before the target matcher was
fixed. The second one is in there because an agent that has only ever seen successful scans will report
an empty range as a clean one, which is the failure this project exists to prevent.

Same tool, same limits, same vocabulary in both documents. If a claim appears in the skill and not here,
one of them is stale, and the stale one is the problem.

Drop the folder into an agent's skill path and it can run a hunt, read the coverage line honestly, and
tell a P0 from a P3 without reading this file first.

## Invariants

Chase ships with eleven invariant checks. Each is intentionally conservative:
they fire on patterns worth a human looking at, not on confirmed exploits.

All eleven have a fixture asserting they fire, out of 12 violation types between them,
and every one of those types is asserted by a committed trace. Seven types come
from synthetic Move packages published to testnet that trigger each detector on
demand. Five do not, because a synthetic trigger would be dishonest: the two
balance checks (`address-balance-delta`, `coin-net-imbalance`) inherit their
false-positive class from how gRPC surfaces balance changes, and the
field/silence checks fire on ordinary order-book traffic. Those are asserted
against organic mainnet transactions, which is a *characterisation* control: it
proves the detector fires on real data of that shape, not that it catches an
exploit. Two kinds of control are different claims and are labelled separately
wherever they appear.

### address-balance-delta

Flags coin types where an address has a negative net balance change within a
transaction. Most fires are benign: when a coin flows into a shared object,
the recipient side doesn't appear in the address-based `balanceChanges`
array, so the sender's debit looks unmatched.

**Severity:** low

A real positive would show a coin type where the total address-based net
across all participants is nonzero and no shared object received the missing
amount. That second half, object-owned balances, is not in the trace, so
this check cannot distinguish the two on its own. It fires on 122 of 6,502
sampled mainnet transactions (1.9%), and the summed view of the same data is
the companion check below.

### coin-net-imbalance

Sums every `balanceChanges` row for a coin type across all addresses in the
transaction and reports a non-zero total: value entered or left the set of
addresses the trace can see.

**Severity:** low

**Measured:** fires on 189 of 6,502 mainnet transactions (2.9%), across 38
coin types. Excluding `0x2::sui::SUI` is load-bearing rather than taste. With gas
counted the same rule fires on 71.6% of traffic, and 4,466 of those fires are
gas alone. It joins the swap-shape cluster in the corroboration table, paired against
`address-balance-delta` (same array, summed vs per address),
`reentrancy-pattern`, `repeated-module-calls` and `flash-loan-shaped`. That
was not a guess: shipping it with only the `address-balance-delta` pair moved
4 transactions from P3 to P2 on this corpus, because the imbalance is produced
by the very routing that trips those three. One swap shape, five ways of
noticing it.

**What this is not:** a supply-change check. The top functions attached to the
net-negative totals are `lending_market::claim_rewards_and_deposit`,
`gateway::provide_liquidity_with_fixed_amount` and `pool::open_position`, and
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

**What this is not:** the field's *key*, meaning which field was added or removed, is not in the trace,
and neither is the parent when the object is not owned by another object. Those are named in the
evidence as unrecorded rather than guessed. A created or deleted field is a state change with a
legitimate routine explanation in most cases; the finding exists so a human can ask which one.

### silent-object-change

Reports a sender-held object that this transaction mutated or destroyed while **no event in the
transaction came from the package that owns the object's type**, checked against both positions Sui
reports, the event type and the event `packageId`, because the latter carries the *updated* package.

**Severity:** low, `corroborates: false`, and a `-20` modifier: alone it lands at NOISE/0.

**Measured:** 38 transactions (0.58%). The obvious rule is the one this is not. "The transaction
emitted no events" fires on **588 transactions (9.04%)** with 2,266 object changes behind them, and
**39% of all mainnet traffic emits nothing at all**, so silence is ordinary behaviour, not a
deviation, and that shape fires on seven of this repo's own twelve committed fixtures (six of
the seven synthetic testnet ones, plus one organic order cancel), because the test
package does not emit at all. A detector like that does not find anything; it raises tiers.

What it says instead of nothing: the report carries `silentObjectChanges` and prints a note when the
transaction changed typed non-framework objects without emitting a single event. That is stated as an
observation with its corpus rate attached, because a clean report on a silent transaction should not
read as a survey of an announceful one.

The population that does fire is dominated by capability-*shaped* types on order books:
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
cached analysis answers the same question the first one did, and when an
object owns the object, the finding names the owning object instead of
apologising. Traces cached before that capture existed report
`recipientKind: "unrecorded"` and say to re-analyze with `--no-cache`, which
is a different claim from `unresolved` (the owner was read and could not be
classified, normally a deleted object, which has no output owner).

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
*between* the borrow and the repay, so a bare `flash_swap` gives `repay_flash_swap` pair with no
 intervening swap does not fire, which the offline suite asserts.

**A gap this detector had, and what closing it cost.** The borrow list omitted `flash_swap`, which is
Cetus's borrow-side entry point (`flash_swap` … `repay_flash_swap`), so that idiom read as three
unrelated calls. It was found by reading an escalated transaction on live mainnet traffic: the
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
different address or left the sender's ownership, so the widening would have
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
entry/exit, so `FLASH_LOAN_SHAPED`, `REPEATED_MODULE_CALLS` and `REENTRANCY_PATTERN` are three names
for one construct, and `enrich.ts` treats them as an expected overlap rather than letting them boost
each other. That rule came out of a live run, not a hunch: over 308 mainnet transactions the only two
findings that reached P2 were Cetus flash swaps scoring "+25 corroboration (3 independent detectors)",
and on the same traffic the fix moved them to P3 (top score 50 → 35) without hiding anything. See
`reports/field-test-2026-09-29.md`.

A second case, decided differently: `DYNAMIC_FIELD_CREATED` fires on 2% of mainnet transactions and
is not a second opinion about anything, but it is genuinely orthogonal to a routing pattern, so
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

A mandate is `{target, checkpoints, goal, budget}`, optionally with `txs`, an
explicit digest list, and `budget: {maxRpcCalls, maxLlmCalls, maxLlmTokens,
maxWallMs, reserveForJudge?}`. The budget is
enforced, not advisory: exceeding any limit raises `BudgetExceeded` and the
run stops with exit code `3`.

The scan does not spend all of it. By default 20% of `maxRpcCalls` (floor 4,
capped at half) is held back for triage and escalation, so findings come back
judged instead of blank. A hunt that burned its last call on one more
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
one pass, no checkpoint sweep, and deliberately no target match, because re-filtering a
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
CHASE HUNT REPORT
=================

Network:  testnet
Target:   explicit:7 tx(s)
Goal:     detect suspicious activity
Mode:     rules
Scope:    7 explicit transaction(s), 1 pass (no checkpoint sweep)
Covered:  seq n/a-n/a (0 wide) | 7 listed | 7 analyzed | 0 no target call | 0 system | 0 repeat
Coverage: complete: every named transaction reached (no checkpoint sweep was performed)


Findings: 7
  9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg [P0] -> ESCALATE
      investigator (suspicious): MUTABLE_REFERENCE_RETURNED (rules layer, not a model)
        read: 1 cmds, 1 pkgs, top 0x101721… ×1, reverted, movement 0x4e7a16… -1023104 sui::SUI | MUTABLE_REFERENCE_RETURNED [0x101721…::leak::leak_mut]
        Signals that do not rest on a function name: MUTABLE_REFERENCE_RETURNED. Name-matched alongside them: none. Check the evidence line against the transaction before acting on this.
      HIGH MUTABLE_REFERENCE_RETURNED: 0x10172126bb0bc55e32dea70a223b7590da2eecf6a1b40bb2c353f1d750f12405::leak::leak_mut returns a mutable reference to the calling transaction; no other non-framework package is invoked in this PTB
  7Y3T5H7oXRhG1vjhnAERiseYW6tY4XndAfHSrrbVwKT2 [P2] -> MANUAL_REVIEW
      investigator (needs-review): name match only (rules layer, not a model)
        read: 2 cmds, 1 pkgs, top 0xe202f2… ×2, succeeded, movement 0x4e7a16… -1036936 sui::SUI | ORACLE_MANIPULATION_SUSPECTED [0xe202f2…::oracle::update_price, 0xe202f2…::oracle::swap]
        Every high-severity signal here fired on a function name: ORACLE_MANIPULATION_SUSPECTED. A name match is not a state change. Read the left-hand function of each pair to check whether it writes a value the right-hand call consumes. Nothing here is evidence either way.
      HIGH ORACLE_MANIPULATION_SUSPECTED: Oracle update at cmd[0] followed by DeFi action at cmd[1]
  EpcqsX3RHDwpE2YAqHcfcKtDExjTBkz5FczQUk9PB4gp [P3] -> MANUAL_REVIEW
      LOW UNANNOUNCED_OBJECT_CHANGE: gift::Prize mutated with no event from gift (the sender held it; now address)
      MEDIUM UNEXPECTED_TRANSFER: Object 0xa2c9a0f328… (gift::Prize) mutated: transferred to non-participant 0x0000000000…
  GoZD6MFDHs6b8u8WLtc7V74iSjwrS2XztXiqPyvPYzzd [P3] -> MANUAL_REVIEW
      MEDIUM REENTRANCY_PATTERN: hop::first re-entered at cmd[2] after call to hop::second (cmds 0 -> 1 -> 2, previous entry of hop::first at cmd[0])
  8s8NfTFMpNKUWW18RK3zZ76zSEGn7EKC4DcbT5B9UEMm [P3] -> MANUAL_REVIEW
      MEDIUM FLASH_LOAN_SHAPED: borrow at cmd[0], action at cmd[1], repay at cmd[2]
  AyBucbogeLhR895L5SDyYucPwsA3gJLcmNn84krjiGEV [P1] -> MANUAL_REVIEW
      investigator (suspicious): CAPABILITY_TRANSFER (rules layer, not a model)
        read: 1 cmds, 1 pkgs, top 0xc28860… ×1, succeeded, movement 0x4e7a16… -1026752 sui::SUI, 1 transfer(s) | CAPABILITY_TRANSFER [coin::TreasuryCap<0xc28860daa55e…]
        Signals that do not rest on a function name: CAPABILITY_TRANSFER. Name-matched alongside them: none. Check the evidence line against the transaction before acting on this.
      MEDIUM UNEXPECTED_TRANSFER: Object 0xb21bf9d9c3… (cap::CAP>) mutated: transferred to non-participant 0x0000000000…
      HIGH CAPABILITY_TRANSFER: TreasuryCap transferred to 0x0000000000…
  CFcSiiRgdsXU7Rb4SVjqEyBbx4yiFJWrASYcHcM56hx9 [NOISE] -> DISMISS
      LOW REPEATED_MODULE_CALLS: 0x54449550645a2fcd9a2436386d03607058ea0f24cb75efcd3dd52dedc6241ec1::repeat called 5 times in one PTB
  … (timestamps, budget usage and the decision chain elided, nothing else changed)
```

The same list run with no cache at all, against testnet transactions the chain no longer holds, is what
the coverage line looks like when it is doing its job properly, and this is genuinely how that output was
first produced:

```
Network:  testnet
Covered:  seq n/a-n/a (0 wide) | 7 listed | 0 analyzed | 0 no target call | 0 system | 0 repeat
Coverage: INCOMPLETE: 7 transactions failed to analyze on testnet (every listed digest failed, which is also what a list spanning two networks looks like)
Findings: 0
```

Two things that line has to carry. It names the network it read, and it says out loud that every listed
digest failed instead of leaving the reader to do the arithmetic. The cause in this instance was retention,
since those testnet transactions are simply gone, and the parenthetical is written as a possibility rather
than a verdict because the tool cannot tell the two apart from here. That is the trade being made: name
the axis the reader needs, do not claim a diagnosis. A `--txs` list is analysed entirely on the mandate's single network, so a file mixing mainnet and
testnet digests is one flag away from an empty report.

The escalation threshold is P0 through P2. A report that investigated everything would
say nothing about which findings it thought mattered, so the `P3` above is
tiered and deliberately left unread.

### What an investigation adds

Triage scores a transaction by counting violations. An investigation reads one:
a trace fetch, then the calls in order, the packages involved, the largest coin
movement, what changed hands, and, the part that settles arguments, the exact
names each high-severity signal fired on. Identical firings collapse into one
counted signal, because a 28-command PTB that trips the oracle heuristic three
times on the same pair of functions has one fact to report, not three.

The verdict comes from the decision layer, and the layer is always named:
`(rules layer, not a model)`, `(read by <model>)`, or
`[DEGRADED: not a model reading]`. The deterministic layer is not allowed to
sound like a judgement it cannot make, so where every high-severity signal came
from a function-name match, which is the documented false-positive surface and what
most organic escalations turn out to be, it answers `needs-review` and names
what to read next, instead of calling a transaction suspicious because its tier
said so.

Asked of a model over the same evidence, the reading is a different kind of
sentence. From a live mainnet transaction the rules layer had deferred:

```
investigator (suspicious): oracle price update followed by flash swap and repayment (read by poolside/laguna-s-2.1:free)
  read: 29 cmds, 5 pkgs, top 0x000000… ×10, succeeded, movement 0xd2c6e3… -4199388 sui::SUI | ORACLE_MANIPULATION_SUSPECTED×3 [0xe48b33…::alpha_lending::update_price, 0x25ebb9…::pool::flash_swap]
  The transaction calls alpha_lending::update_price at cmd[4], cmd[7], and cmd[10], each
  immediately followed by oracle::get_price_info and type_name::get, then executes
  pool::flash_swap at cmd[11] and cmd[14], with pool::repay_flash_swap at cmd[17] and cmd[27].
  … (the sentence continues; it runs to four)
```

Two things follow from that pair. The layers can disagree on identical evidence,
which is exactly why the source is printed; and a model's sentence is a
hypothesis about commands it can see, not a verdict on code it cannot see. The
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

That run's report then says `Coverage: INCOMPLETE: 2 of 7 listed txs not
reached`, and the two transactions it never got to are named rather than absent.

Coverage is reported rather than assumed. Four kinds of "nothing" are kept
apart: no pass ran at all (`NO SCAN RAN` / `NOTHING SCANNED`, from a dry run or an
exhausted budget is not a result about the target); the range held no
transactions; the range held transactions but none matched the target
(`EMPTY AGAINST THE TARGET, not a clean scan`); or the target was reached and
stayed clean. A `--dry-run` used to print `Coverage: complete` because it had
listed zero transactions and reached all of them, technically true, and the
kind of sentence that gets read as a clean sweep.

Target matching is done client-side, against the transaction's own trace:
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
│   ├── cursor.ts               # watch position: per network, XDG_DATA_HOME
│   ├── owner.ts                # the SDK's five owner shapes, recorded not derived
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
    ├── capability-transfer.ts  # capability object transfers
    ├── coin-net-imbalance.ts   # value crossing the address-visible set
    ├── dynamic-field-lifecycle.ts  # fields created or destroyed, never merely mutated
    └── silent-object-change.ts # sender-held change with no event from its own package
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
npm run test:agent        # 318 checks: target matching, budget reserve, investigator
                          # (reading, evidence, provenance), detector keyword shapes,
                          # batch shape, CLI validation, dry-run coverage, manifest/lock
                          # agreement, endpoint configuration, owner vocabulary and
                          # owner recording (incl. a real save->load round trip), the
                          # declaration gate (every emitted type has a deliberate triage
                          # entry, exactly one owner, a README row and a fixture), the
                          # watch cursor store and bounded watch ranges, and
                          # the watch cursor -- including the loop itself, offline,
                          # through injected fetcher/sleep/exit seams
npx tsx scripts/test-budget.ts   # Budget unit checks (rpc/llm/token/time)
```

```bash
npm test                  # all four suites
```

All four read committed fixtures or need no network at all, so a fresh clone with
no `.env` passes offline, which also means none of them can tell you whether the
transport still answers.
For that:

```bash
npm run smoke:live                 # three live mainnet transactions, uncached
CHASE_SMOKE_TXS=2 npm run smoke:live testnet
```

`smoke:live` runs against `dist/`, lists the checkpoint two behind the tip,
analyzes up to three programmable transactions and exits non-zero if none
could be analyzed. It is the check that catches a retention-window change, a
gRPC shape break, or an endpoint that stopped responding, none of which a
fixture can see.

Detection quality is measured, not asserted, and the measurement is offline:

```bash
npm run corpus -- after      # over whatever is in the trace cache
```

It runs the full invariant + triage pipeline over every trace in the local cache
(`~/.cache/chase/<network>/`), with history disabled so two runs are comparable, and
prints the flag rate, the worst tier per transaction, and the per-type breakdown. No
RPC, and it repeats exactly. Run it as `npm run corpus`, not `node
scripts/corpus-report.mjs`: the script used to import `dist/`, which meant it priced
whatever was last *built* rather than what you changed, and adding a ninth invariant
produced a byte-identical report, which looks exactly like a null result. This is how a detector change gets priced: adding
`flash_swap` to the borrow keywords moved `FLASH_LOAN_SHAPED` from 90 to 154 findings
and the flag rate from 10.0% to 10.9% across 6,502 cached mainnet transactions, while
high-severity findings stayed at 16 and the P1 count stayed at 4, because every added fire
landed at P3. The whole 0.2.0 trail, including two escalations this command caught before
they shipped, is kept in `reports/0.2.0-detector-pricing.md`.

Twelve cases, twelve committed traces (the file this list is generated from):

- **mainnet**: order cancel gives no violations
- **mainnet**: aggregator swap gives `ADDRESS_OUTFLOW`, `COIN_NET_IMBALANCE`, `REENTRANCY_PATTERN`
- **testnet**: synthetic public &mut leak gives `MUTABLE_REFERENCE_RETURNED`
- **testnet**: synthetic oracle update + swap gives `ORACLE_MANIPULATION_SUSPECTED`
- **testnet**: synthetic gift transfer to non-participant gives `UNANNOUNCED_OBJECT_CHANGE`, `UNEXPECTED_TRANSFER`
- **testnet**: synthetic A -> B -> A composition gives `REENTRANCY_PATTERN`
- **testnet**: synthetic borrow -> swap -> repay gives `FLASH_LOAN_SHAPED`
- **testnet**: synthetic TreasuryCap transfer gives `CAPABILITY_TRANSFER`, `UNEXPECTED_TRANSFER`
- **testnet**: synthetic repeated module calls gives `REPEATED_MODULE_CALLS`
- **mainnet**: order-book fill gives `DYNAMIC_FIELD_CREATED`
- **mainnet**: game round teardown gives `COIN_NET_IMBALANCE`, `DYNAMIC_FIELD_CREATED`, `DYNAMIC_FIELD_DELETED`
- **mainnet**: order cancel gives `UNANNOUNCED_OBJECT_CHANGE`

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
  `archive.mainnet.sui.io`, which was measured on 2026-09-29 and is reachable
  without any token, but it also returns `not found` for digests the fullnode
  has pruned, including two of this repo's own mainnet fixtures. So the
  fallback is attempted and does not recover history; the error now says so
  instead of reporting a bare second miss. Two of the twelve committed traces can only be
  re-analysed because their traces are committed. The fix is an endpoint that
  keeps history: point `SUI_ARCHIVE_URL` at a provider archive (Triton,
  Quicknode) or your own archival node, and pruned digests resolve. A failure
  on the way there is now named. An empty-message gRPC error used to print
  `RpcError` and nothing else, which is how nine transactions vanished
  unexplained in a 1,106-tx run; it now reports
  `gRPC RpcError <code> (<details>) while reading <digest>`.

- **`balanceChanges` is address-scoped.** Shared-object balance changes
  appear as `effects.changedObjects` mutations, not as address deltas. This
  is the root cause of most fires from `address-balance-delta`, which is why
  it's rated low severity and includes an explanatory note in its evidence.

- **`repeated-module-calls` threshold is tuned high.** Set to 5 calls per
  module to avoid firing on every DeFi aggregator PTB.

- **Listings are capped per request.** Measured on mainnet: one
  `listTransactions` call returns at most 500 transactions and reports
  `complete=false`. A wide `--checkpoints` range is therefore sampled from the
  start of the range rather than swept end to end. The hunt report says so:
  `a listing stopped before the checkpoint bound` plus `N of M listed txs not
  reached`, so spend the budget on repeated narrow ranges instead of one wide
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
  arguments, so the question that usually decides a case, namely who can call this and what
  it writes, is answered by reading the Move source, not by Chase. The
  deterministic layer therefore returns `needs-review` when a high-severity signal
  rests on a name alone, and a model's `suspicious` on the same evidence is a
  hypothesis with a named next read, not a finding. Both are labelled with the
  layer that answered.

- **`ownership-anomaly` produces no signal on shared-object flows.** The
  recipient must be an address owner for the check to fire.

- **The offline watch-loop test drives a fake listing.** `chase watch` had no automated coverage at
  all before the cursor landed, because its fixture path needs checkpoint listings rather than just
  traces and a live listing cannot be committed. What the test proves is the loop's bookkeeping:
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

- [ ] Reconstruct object-owned balances to reduce `address-balance-delta` noise.
      **Partly answered, and only partly:** `coin-net-imbalance` now sums each
      coin type across the address set (2.9% of traffic versus 1.9% for the
      per-address rule) and names the transaction's non-framework calls as the
      candidate mechanism. The real version needs object-side balances, which
      are not in the trace at all, which requires widening the gRPC `include`
      fields and re-fixturing, and was declined for this pass rather than left
      unfixed by accident.
- [x] Configurable RPC endpoints: `SUI_RPC_URL` / `SUI_ARCHIVE_URL` (0.1.4), so
      a Triton, Quicknode or self-run archive can be used for historical
      analysis. The public archive endpoint is reachable without a token but
      does not hold pruned digests, so a token would not have fixed the
      retention gap; an override is what does.
- [x] Persist checkpoint cursor across watch runs (0.2.0), per network, in
      `$XDG_DATA_HOME`, resuming from the last checkpoint it actually finished
      and refusing to clamp forward past the retention floor. 0.3.0 made the
      position a user-facing thing: `--to` bounds a range and stops honestly at
      the tip, `--status` prints where it left without a network call, and
      `--reset-cursor` forgets one network without touching the others.
- [x] Additional invariants: dynamic field abuse, event-less state changes
      (0.2.0), as `dynamic-field-lifecycle` (create/delete, report-only) and
      `silent-object-change` (0.58%, the narrowed end; the 9% "no events at all"
      shape is printed as an observation instead of scored, because 39% of
      traffic is silent and it fires on seven of this repo's own fixtures).
      Field *keys* and true object balances remain out of reach without new
      `include` fields.
- [x] Publish to npm as `@zeroxcyril/chase`, installable and runnable via `npx`
      without a git clone
- [ ] Scout agent: autonomous *target selection* (the scanning loop, budget,
      triage and investigation pass shipped; the target still comes from the
      mandate). This is a design question, not a code drop: nothing ranks
      packages across traces today, and "target required" is a deliberate
      invariant, so autonomy has to be proposed-then-confirmed rather than the
      scout picking its own subject.

## Development

Contributing is written up in [CONTRIBUTING.md](CONTRIBUTING.md), including the two rules that matter most: a detector change is not finished until `npm run corpus -- <label>` has priced it, and a claim that some check guards has to be demonstrated by breaking it on purpose. The short version of the workflow:

```bash
npm install                          # runs the build through `prepare`
npm run analyze -- <DIGEST> --debug  # verify the fetcher works against a real transaction
npm run typecheck && npm test          # src is typechecked; scripts/ is not, by either
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

## Security policy

Chase is an analysis tool, not a service, so the interesting question is what happens when you feed it
untrusted input. It parses transaction digests from the command line, from JSON reports, and from agent
tool calls, and a digest becomes a cache filename, which is why `src/lib/digest.ts` shape-checks before
anything touches the disk. It reads execution traces published on a public chain, so trace content is
attacker-influenced by construction: function names, module names, type strings and event JSON all reach
the report, and the model-facing prompt in `src/agent/llm.ts` deliberately feeds the model only the
normalised evidence it assembled itself, never raw trace text.

Please report a vulnerability in Chase itself, rather than a finding about a chain, to the repository's
private security contact as described in [SECURITY.md](SECURITY.md). A report that says "this tool flagged
my protocol" is a support question, and it is a reasonable one, but it is not a security issue in Chase.

## Supported versions

| Version | Status |
|---|---|
| 0.2.x | Current. Fixes land here first. |
| 0.1.x | Unsupported. 0.1.0 through 0.1.3 each shipped a real defect that later releases fixed, including a hunt report that described an empty scan as complete and a corpus tool that measured stale build output. |

Because this is a CLI and a library rather than a hosted service, "supported" mostly means the trace
normalisation still matches what a Sui fullnode returns, which is why `npm run smoke:live` exists: a gRPC
shape change is a support problem for every old version at once.

## Changelog

Release-by-release changes, with the measurement that justified each one, are in [CHANGELOG.md](CHANGELOG.md). Every published version also has an annotated tag and a GitHub release, `v0.1.0` through the current release. The 0.1.x tags are backfilled and anchored to the commit that set each version in `package.json`, which makes them version anchors rather than build provenance, since publishing is done by hand from a working tree.
The longer narrative for this release, including two detector escalations that were caught in pricing and
reverted before shipping, is in `reports/0.2.0-detector-pricing.md`.

## Acknowledgments

The `mutable-access` invariant is inspired by OpenZeppelin's published audit
findings on Sui Move visibility bugs. The `oracle-pattern` heuristic is
modelled on publicly documented Sui DeFi incidents.

## License

MIT. See [LICENSE](LICENSE).
