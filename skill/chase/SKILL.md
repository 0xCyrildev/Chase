---
name: chase
description: "Dynamic analysis of Sui Move transactions. Fetches a transaction's real execution trace over gRPC, runs eleven deterministic invariant checks on what actually executed, scores findings into tiers P0 to P3 or NOISE with a recommended action, and can run a budget-bounded scout agent that watches a package across checkpoints. Complements static analysis by reasoning about behaviour after deployment instead of source before it. Triggers on 'chase', 'dynamic analysis', 'what did this transaction do', 'Sui trace', 'Sui Move audit', 'monitor this package', 'post-exploit analysis', 'analyze this digest', 'is this protocol being exploited'."
---

# Chase

Static analysis reads what a contract claims it will do. Chase reads what a transaction actually did,
out of the executed trace, and it does this for reverted transactions too, which is a polite way of
saying it looks at the attacks that failed.

`$SKILL_DIR` = the directory containing this SKILL.md.

## When to use it

| Situation | Use |
|---|---|
| Contract source, before deployment | a static skill, this is the wrong tool |
| "What did this transaction actually do?" | `chase_analyze` on the digest |
| "Is anyone calling this protocol strangely right now?" | `chase_hunt` with a mandate and a budget |
| "Was this exploit real, or is it noise being confident?" | `chase_triage`, which scores, suppresses known benign shapes, and names an action |
| Post-incident review of a known attack transaction | `chase_analyze`, reverted included |
| A transaction you met during an audit and want checked at runtime | `chase_analyze` |

Chase is not a vulnerability scanner and it never reads source. A clean trace does not mean a package is
safe. It means that one transaction did not do the things Chase looks for, which is a much smaller claim
and the only honest one available.

## Setup

Installed once, globally:

```bash
npm install -g @zeroxcyril/chase
chase analyze <TX_DIGEST>
```

Or with nothing installed, which is the form a reviewer tends to try first:

```bash
npx -y -p @zeroxcyril/chase chase analyze <TX_DIGEST>
npx -y -p @zeroxcyril/chase chase triage <TX_DIGEST>
npx -y -p @zeroxcyril/chase chase-hunt --target <package_id> --mode rules
npx -y -p @zeroxcyril/chase chase-mcp
```

The `-p` bit is not decoration. The package installs four commands, `chase`, `chase-triage`,
`chase-hunt` and `chase-mcp`, so npx needs to be told which one you mean before it will agree to be a
package runner. Drop it and you are asking a question the tool cannot answer. Up to and including 0.2.0
the bare form was worse than ambiguous and failed with `Permission denied`, because the build emitted
the bin files without an execute bit and npm packed the modes it was handed. That is fixed in 0.2.1 and
there is a test over it, since a quickstart line that does not work reads exactly like a broken tool.

No credentials are needed to analyse anything. The default network is mainnet and the public gRPC
endpoint is used directly, so the commands above run on a machine with no `.env` and no API key. If you
work from a source checkout, `git clone` then `npm install` gives you the same behaviour, and the
`npx tsx src/...` forms further down apply.

The optional layers read `LLM_API_KEY`, `LLM_ENDPOINT` and `LLM_MODEL`, and any OpenAI-compatible
endpoint will do. You need them for `--explain` prose and for `chase_hunt` with `mode: "real"`. Nothing
else asks for a model, and the deterministic default is the one that is tested.

`SUI_RPC_URL` and `SUI_ARCHIVE_URL` replace the public fullnodes with a provider or your own node, which
is the only way to read a transaction older than the public retention window. Both must be `https://` and
both are checked at startup, so a typo costs you one clear error rather than one thousand quiet failures
per transaction.

There is also a wrapper, for when you would rather not compose CLI flags at all. It prints triaged JSON
and keeps Chase's exit codes, where `1` means a violation fired and not that something fell over:

```bash
$SKILL_DIR/scripts/chase-analyze.sh <TX_DIGEST> [mainnet|testnet|devnet]
```

MCP registration, published form:

```bash
claude mcp add --transport stdio --scope user chase -- npx -y -p @zeroxcyril/chase chase-mcp
```

```bash
codex mcp add chase -- npx -y -p @zeroxcyril/chase chase-mcp
```

Cursor or VS Code, in `.cursor/mcp.json` or the editor's MCP config, is the same stdio server:

```json
{
  "mcpServers": {
    "chase": {
      "command": "npx",
      "args": ["-y", "-p", "@zeroxcyril/chase", "chase-mcp"]
    }
  }
}
```

From a checkout instead of the registry, point the same slot at the source and let tsx run it:

```bash
claude mcp add --transport stdio --scope user chase -- npx tsx /path/to/Chase/src/mcp-server.ts
```

## Tools

| Tool | Inputs | Returns |
|---|---|---|
| `chase_analyze` | `digest`, `network`, `debug`, `useCache` | violations with severity and evidence, stats, sender, and the success flag |
| `chase_triage` | `digests[]`, `network`, `explain`, `minTier` | findings with `tier`, `score`, `nextAction`, `rationale`, caveats, and `skipped[]` for digests that could not be analyzed |
| `chase_list` | `startCheckpoint`, `endCheckpoint`, `network`, `limit`, optional `target` and `inspect` | digests in range, plus, when `target` and `inspect` are both given, which inspected transactions actually involved that package, and a `presenceClaim` |
| `chase_watch` | `from`, `to`, `network`, optional `filter` | findings in a bounded checkpoint range, with coverage counts |
| `chase_hunt` | `target` or `txs` (an explicit digest list), `checkpoints`, `goal`, `mode`, budget (`maxRpcCalls`, `maxLlmCalls`, `maxLlmTokens`, `maxWallMs`, optional `reserveForJudge`) | the scout's report: decisions, findings with tiers, investigator readings on P0 to P2, coverage, budget used |
| `chase_query` | nothing | signature cache size and cache directory |

## How to run an agent workflow

1. **Find activity.** `chase_list` over a narrow range. If you need to know whether a particular package
   turns up, pass `target` and `inspect` together, because a listing on its own makes no presence claim
   and `inspect=0` with a target answers `NOT CHECKED`.
2. **Analyze what matters.** `chase_analyze` on the candidate digests. A reverted transaction is normal
   input here, not a reason to move on.
3. **Triage.** `chase_triage` turns raw violations into a tier and an action. Read `rationale`, which
   shows the arithmetic instead of announcing a conclusion.
4. **Escalate with the right vocabulary.** `ESCALATE` means a human should look at this. It does not mean
   a vulnerability was found, and the difference is the whole product.
5. **For continuous monitoring**, `chase_hunt` with a mandate and a budget. Several narrow hunts beat one
   wide one, because a listing returns at most 500 transactions per call and says `complete=false` when it
   stops early, so a wide range gets sampled at the top and reported as if it were swept.
6. **When specific transactions are already in question**, pass `txs` instead of a target. The scout
   analyzes exactly those digests in one pass, with no checkpoint sweep and no target filter. Use this
   instead of a window hunt when somebody hands you digests, because "I looked at these" and "I swept a
   range" are different claims and the report keeps them apart (`Scope: N explicit transaction(s), 1 pass`,
   `Covered: seq n/a-n/a (0 wide)`).

## Reading the output honestly

Every layer keeps its own uncertainty visible, and flattening that is how a tool talks itself into a
finding.

- **`INCOMPLETE` in coverage** means part of the range was never reached. Read that line before you read
  `0 findings`.
- **Four different kinds of nothing.** A hunt separates: no pass ran at all (`NO SCAN RAN` /
  `NOTHING SCANNED`, which is what a dry run or a spent budget produces, and says nothing about the
  target); the range held no transactions (`EMPTY SCAN`); the range held transactions but none involved the
  target (`EMPTY AGAINST THE TARGET, not a clean scan`); and the target was reached and stayed clean. The
  first three are not evidence of good behaviour.
- **`skipped[]` in a triage report** names the digests that could not be analyzed, so a report covering 2
  of 4 inputs admits covering 2 of 4.
- **`[DEGRADED: not a model decision]`** marks a fallback decision, and a fallback summary prints
  `(generated by the fallback, not by the model)`, because a confident sentence from a fallback is how a
  hallucination gets promoted.
- **An escalated finding carries a reading and says who wrote it.** `investigation.source` is `model`,
  `rules`, `stub` or `fallback`, and the reports print it as `(rules layer, not a model)`,
  `(read by <model>)` or `[DEGRADED: not a model reading]`. Treat a `rules` verdict as shape
  classification rather than judgement. When a high severity signal rests on a function name alone, which
  is the common case in organic traffic, that layer is designed to answer `needs-review` and say what to
  read next.
- **`investigation.evidence` is the checkable part**: command count, packages by call count, largest coin
  movements, transfers, events, and `signals[]` naming the exact functions each high severity detector
  matched, with identical firings collapsed into one entry carrying a `count`. Quote from it instead of
  restating a verdict, and keep in mind it contains no function signatures or arguments, so the question
  "who can control this value" belongs to the Move source and not to this evidence.
- **`mode: "rules"` is the default** for `chase_hunt`: deterministic, no key, reproducible on someone
  else's machine. Reach for `real` when you want model reasoning in the loop, and put it in the budget.
- **Budgets are hard stops.** Going over any limit ends the run, and the CLI exits `3`. The scan holds part
  of the RPC budget back, 20% by default, `reserveForJudge` to change it, `0` if you really mean it, so
  findings come back triaged instead of untiered, and it prints `held back for judgement` when that is what
  stopped the pass. Anything triage still cannot reach is labelled `triage not attempted: …` rather than
  left blank, because a blank looks like a clean answer.

## Detectors and their false-positive class

| Invariant | What it catches | Known FP class |
|---|---|---|
| `MUTABLE_REFERENCE_RETURNED` | public function returning `&mut T` | deterministic, +20 confidence |
| `CAPABILITY_TRANSFER` | `TreasuryCap`, `AdminCap`, `UpgradeCap` and friends reaching a non-participant | legitimate ownership handovers |
| `UNEXPECTED_TRANSFER` | an object moving to an address that never touched the transaction | custodial and shared-object flows |
| `REENTRANCY_PATTERN` | an A to B to A call sequence inside one PTB | **DEX routers and aggregators** (-10) |
| `ORACLE_MANIPULATION_SUSPECTED` | an oracle update followed by a DeFi action in one PTB | **name-based**, so protocols that update their own oracle |
| `FLASH_LOAN_SHAPED` | borrow, action, repay keywords in one PTB | **name-based**, so every legitimate flash loan ever |
| `REPEATED_MODULE_CALLS` | the same module called five or more times in one PTB | **aggregator PTBs** (-20), and the threshold is deliberately high |
| `ADDRESS_OUTFLOW` | a coin leaving an address with no matching credit | **heuristic**, because shared-object inflows never appear in `balanceChanges` |
| `COIN_NET_IMBALANCE` | a coin type whose rows do not sum to zero across the addresses in the transaction | deposits and withdrawals through shared objects, which is most of what it fires on |
| `DYNAMIC_FIELD_CREATED` | a `dynamic_field::Field` object appearing in the transaction | ordinary state growth, so it is report-only |
| `DYNAMIC_FIELD_DELETED` | a `dynamic_field::Field` object being destroyed | ordinary teardown, also report-only |
| `UNANNOUNCED_OBJECT_CHANGE` | a sender-held object mutated or destroyed while its own package emitted no event | silent updates by design, and the population is mostly capability-shaped order-book objects |

Three detectors are keyword-based on purpose, several more are shape-based, and all of them produce triage
signals rather than verdicts. The benign-pattern library exists to quiet the ones that keep recurring.

Two of the newest types carry `corroborates: false`, and the reason is worth knowing before you raise a
threshold. Corroboration is what lifts other findings, so a detector that fires on 2% of all mainnet
traffic is a poor witness even when it is an interesting fact. Chase therefore has two separate mechanisms
for that: a pair in the overlap table means "these describe the same construct", and report-only means
"this is stated and does not escalate anything". Those are different sentences and the code insists on
them staying different.

Every violation type has a committed trace that asserts it fires, but two kinds of control exist and are
named separately. Seven types come from a synthetic Move package published to testnet, with the source in
this repo under `test-cases/synthetic-leak/`. Five come from organic mainnet transactions, because a
synthetic trigger would overstate what they prove. An organic case is a characterisation control: the
detector fires on real data of that shape, which is not the same claim as "it catches an exploit", and
Chase has still not made the second claim.

## Limits to state in any report

- **Retention.** Public fullnodes prune history, so a digest older than roughly three weeks returns `not
  found`. Chase then tries the public archive endpoint, and the measurement there is unkind: that endpoint
  answers without needing a token, which the old README denied, but it also returns `not found` for
  pruned digests, so the fallback recovers nothing. For older transactions point `SUI_ARCHIVE_URL` at a
  provider or your own archival node, https only, refused at startup if malformed. A gRPC read that fails
  without a message of its own no longer surfaces as a bare `RpcError` either; it names the code, the
  details, and the digest it was reading.
- **Balances are address-scoped.** Shared-object changes show up as object mutations, not address deltas,
  which is the noise source behind `ADDRESS_OUTFLOW`, and the reason `COIN_NET_IMBALANCE` sits next to it
  rather than replacing it, since one view of a broken balance is not a second opinion about it.
- **Routed volume has a matching ceiling.** Presence is checked against top-level call packages, event type
  prefixes and object type prefixes. A protocol reached only inside another package's internal calls, with
  no type in the events or object changes, is invisible to it. Never upgrade "not found" to "not called".
- **The gRPC `moveCall` listing filter under-matches and is not used.** On mainnet it returned rows for
  `0x2` while answering "nothing, `complete=true`" for `0x2::transfer` and for a busy DEX package present
  in 8% of sampled transactions. Presence requires `inspect`, which fetches traces.
- **Testnet wipes.** The testnet fixtures can expire one day. The repo carries their committed traces, so
  the suites keep running offline either way.
- **One chain.** Sui Move only. It does not read source, so a bug that has never been executed is
  invisible here by construction, and that is the trade rather than a defect.
