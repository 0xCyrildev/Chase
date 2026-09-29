---
name: chase
description: "Dynamic analysis of Sui Move transactions: fetches a transaction's real execution trace over gRPC, runs eight deterministic invariant checks on what actually executed, scores findings into tiers P0-P3/NOISE with a recommended action, and can run a budget-bounded scout agent that watches a package across checkpoints. Complements static analysis by reasoning about behaviour after deployment instead of source before it. Triggers on 'chase', 'dynamic analysis', 'what did this transaction do', 'Sui trace', 'Sui Move audit', 'monitor this package', 'post-exploit analysis', 'analyze this digest', 'is this protocol being exploited'."
---

# Chase

Dynamic analysis for **Sui Move**. Static skills reason about what contracts say. Chase reasons about
what transactions **did** — the executed trace, including transactions that reverted.

`$SKILL_DIR` = the directory containing this SKILL.md.

## When to use it

| Situation | Use |
|---|---|
| Contract source, pre-deployment | static skills, not this |
| "What did this transaction actually do?" | `chase_analyze` on the digest |
| "Is anyone calling this protocol suspiciously right now?" | `chase_hunt` with a mandate and budget |
| "Was this exploit real, or noise?" | `chase_triage` — it scores, matches benign patterns, and names an action |
| Post-incident review of a known attack tx | `chase_analyze`, including reverted transactions |
| A tx you found while auditing, to check its runtime shape | `chase_analyze` |

Chase is **not** a vulnerability scanner and does not read source. A clean trace is not proof that a
package is safe; it is proof that this transaction did not do those things.

## Setup

```bash
git clone https://github.com/0xCyrildev/Chase.git && cd Chase && npm install
```

No credentials are needed to analyze transactions — the default network is mainnet and the public gRPC
endpoint is used directly.

Optional layers read `LLM_API_KEY` / `LLM_ENDPOINT` / `LLM_MODEL` (any OpenAI-compatible endpoint) and
are needed only for `--explain` prose and for `chase_hunt` / `chase hunt` with `mode: "real"`.

One-call wrapper, if you would rather not compose the CLI yourself (prints triaged JSON, keeps Chase's
exit codes — `1` means a violation fired, not that the tool broke):

```bash
$SKILL_DIR/scripts/chase-analyze.sh <TX_DIGEST> [mainnet|testnet|devnet]
```

MCP registration:

```bash
claude mcp add --transport stdio --scope user chase -- npx tsx /path/to/Chase/src/mcp-server.ts
```

```bash
codex mcp add chase -- npx tsx /path/to/Chase/src/mcp-server.ts
```

Cursor / VS Code (`.cursor/mcp.json`, or VS Code's MCP config) — same stdio server:

```json
{
  "mcpServers": {
    "chase": {
      "command": "npx",
      "args": ["tsx", "/path/to/Chase/src/mcp-server.ts"]
    }
  }
}
```

## Tools

| Tool | Inputs | Returns |
|---|---|---|
| `chase_analyze` | `digest`, `network`, `debug`, `useCache` | violations with severity + evidence, stats, sender, success flag |
| `chase_triage` | `digests[]`, `network`, `explain`, `minTier` | findings with `tier`, `score`, `nextAction`, `rationale`, caveats, and `skipped[]` for digests that could not be analyzed |
| `chase_list` | `startCheckpoint`, `endCheckpoint`, `network`, `limit`, optional `target` + `inspect` | digests in range, plus — when `target` and `inspect` are given — which inspected transactions actually involved that package, and a `presenceClaim` |
| `chase_watch` | `from`, `to`, `network`, optional `filter` | findings in a bounded checkpoint range, with coverage counts |
| `chase_hunt` | `target`, `checkpoints`, `goal`, `mode`, budget (`maxRpcCalls`, `maxLlmCalls`, `maxLlmTokens`, `maxWallMs`, optional `reserveForJudge`) | the scout's report: decisions, findings with tiers, coverage, budget used |
| `chase_query` | — | signature cache size and cache directory |

## How to run an agent workflow

1. **Locate activity.** `chase_list` over a narrow range. If you need to know whether a specific package
   is present, pass `target` **and** `inspect` — a listing alone makes no presence claim, and `inspect=0`
   with a target returns `NOT CHECKED`.
2. **Analyze what matters.** `chase_analyze` on candidate digests. Reverted transactions are valid input.
3. **Triage.** `chase_triage` turns raw violations into a tier and an action. Read `rationale` — it shows
   the arithmetic, not a verdict.
4. **Escalate deliberately.** `ESCALATE` means "a human should look", not "this is a vulnerability".
5. **For continuous monitoring**, `chase_hunt` with a mandate and a budget. Prefer several narrow hunts
   over one wide one: a listing returns at most 500 transactions per call and reports
   `complete=false` when it stops early, so a wide range is sampled at its head.

## Reading the output honestly

Every layer keeps its own uncertainty visible. Do not flatten it.

- **`INCOMPLETE` in coverage** means part of the range was never reached. Read it before reading
  `0 findings`.
- **Three different nothings.** A hunt distinguishes: the range held no transactions; the range held
  transactions but none matched the target (`EMPTY AGAINST THE TARGET, not a clean scan`); and the target
  was reached and stayed clean.
- **`skipped[]` in a triage report** names the digests that could not be analyzed. A report covering 2 of
  4 inputs says so.
- **`[DEGRADED: not a model decision]`** marks a fallback decision; a fallback summary prints
  `(generated by the fallback, not by the model)`.
- **`mode: "rules"` is the default** for `chase_hunt`: deterministic, no API key, reproducible. Use
  `real` only when you want LLM reasoning in the loop, and account for it in the budget.
- **Budgets are hard stops.** Exceeding any limit ends the run (CLI exit `3`). The scan holds part of the
  RPC budget back — 20% by default, `reserveForJudge` to set it, `0` for none — so findings get triaged
  instead of coming back untiered; it prints `held back for judgement` when that bound stops the pass.
  Anything triage still cannot reach is labelled `triage not attempted: …`, never left blank.

## Detectors and their false-positive class

| Invariant | What it catches | Known FP class |
|---|---|---|
| `MUTABLE_REFERENCE_RETURNED` | public function returning `&mut T` | deterministic; +20 confidence |
| `CAPABILITY_TRANSFER` | `TreasuryCap`/`AdminCap`/`UpgradeCap` to a non-participant | legitimate ownership handovers |
| `UNEXPECTED_TRANSFER` | object moved to an address that never touched the tx | custodial and shared-object flows |
| `REENTRANCY_PATTERN` | A → B → A call sequence in one PTB | **DEX routers and aggregators** (−10) |
| `ORACLE_MANIPULATION_SUSPECTED` | oracle update followed by a DeFi action in one PTB | **name-based** — protocols that update their own oracle |
| `FLASH_LOAN_SHAPED` | borrow → action → repay keywords in one PTB | **name-based** — any legitimate flash-loan usage |
| `REPEATED_MODULE_CALLS` | same module called ≥5 times in one PTB | **aggregator PTBs** (−20); threshold deliberately high |
| `ADDRESS_OUTFLOW` | coin leaves an address with no matching credit | **heuristic**; shared-object inflows are not in `balanceChanges` |

Three detectors are keyword-based by design. They produce triage signals, never verdicts, and the
benign-pattern library exists to suppress the ones that recur.

All eight have positive controls: a synthetic Move package published to testnet that fires each detector
on demand (source in the Chase repo at `test-cases/synthetic-leak/`), asserted by nine offline fixtures
that run without network access.

## Limits to state in any report

- **Retention.** Public fullnodes prune history; roughly beyond ~21 days a digest returns `not found`.
  Chase then tries the public archive endpoint — measured, that endpoint answers without any token but
  also returns `not found` for pruned digests, so the fallback does not recover history. For older
  transactions, point Chase at a provider or your own archival node (configurable endpoints are not
  implemented yet).
- **Balances are address-scoped.** Shared-object changes appear as object mutations, not address deltas,
  which is the noise source behind `ADDRESS_OUTFLOW`.
- **Routed volume has a matching ceiling.** Presence is checked against top-level call packages, event
  type prefixes and object type prefixes. A protocol reached only inside another package's internal calls,
  with no type in the events or object changes, is invisible. Do not upgrade "not found" to "not called".
- **The gRPC `moveCall` listing filter under-matches and is not used.** Measured on mainnet it returned
  rows for `0x2` while answering "nothing, `complete=true`" for `0x2::transfer` and for a busy DEX package
  id present in 8% of sampled transactions. Presence requires `inspect`, which fetches traces.
- **Testnet wipes.** Testnet fixtures can expire; the repo carries committed traces so the suites run
  offline regardless.
- **One chain.** Sui Move only. It does not read source, so it will not tell you about a bug that has
  never been executed.
