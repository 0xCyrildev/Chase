# Chase field test — live mainnet, 2026-09-29

Everything below is measured against real Sui mainnet traffic through the **published npm artifact**
(`@zeroxcyril/chase`, installed clean into a temporary prefix), not a source checkout. Numbers are
reproducible with the commands shown; nothing here is a fixture.

## Corpus

308 transactions from a spread of checkpoints (`tip-200 … tip-8`, sampled every 10th), analyzed
uncached, concurrency 6.

| | |
|---|---|
| analyzed | **308** |
| reverted transactions analyzed | 13 (attempted calls inspected, not skipped) |
| system transactions skipped | 68 |
| not-found / fetch errors / detector errors | **0 / 0 / 0** |
| wall time | 41.5 s → **7.4 tx/s** sustained against the public gRPC fullnode |
| distinct transactions with ≥1 violation | 25 (**8.1%**) |

Violations by detector:

```
   14  REPEATED_MODULE_CALLS
   10  REENTRANCY_PATTERN
    3  ADDRESS_OUTFLOW
    3  FLASH_LOAN_SHAPED
```

Nothing high-signal fired: **0** `MUTABLE_REFERENCE_RETURNED`, **0** `CAPABILITY_TRANSFER`, **0**
`ORACLE_MANIPULATION_SUSPECTED` across 308 real transactions. That is the expected base rate for
healthy traffic and it is the result worth stating: the noisy detectors are the only ones that see
anything on ordinary mainnet activity, and 8.1% flag rate is a triage input, not a 308-suspect list.

## Triage, over the flagged set

`chase batch` over the 31 flagged digests: **31/31 analysed, 121 violations, 0 detector errors**.
`chase triage` on that batch file (the documented pipeline):

```
tiers:   P0 0  P1 0  P2 8  P3 89  NOISE 24
actions: DISMISS 24   MANUAL_REVIEW 97   ESCALATE 0
```

So the layer suppressed 20% outright, held 74% at P3, and produced **no false escalation** on live
data. Caveats printed themselves (name-based detectors, shared-object balance scoping, the ≥5
threshold), rather than waiting to be asked.

## What the field test broke: a scoring flaw, found and fixed

The 8 P2 findings came from **two transactions**. Both were Cetus flash swaps:

```
FBuRxJnkAHd6…  FLASH_LOAN_SHAPED  P2/50
   rationale: base=30 · +25 corroboration (3 independent detectors:
              ADDRESS_OUTFLOW, REPEATED_MODULE_CALLS, REENTRANCY_PATTERN)
9UwYVp9T2d82…  FLASH_LOAN_SHAPED  P2/45   (reverted)
```

"3 independent detectors agree" was one construct counted three times. A flash swap is
`borrow → action → repay` (FLASH_LOAN_SHAPED), it calls one pool module repeatedly
(REPEATED_MODULE_CALLS), and its entry/exit sequence reads as re-entry (REENTRANCY_PATTERN). Corroboration
between them is not corroboration.

`enrich.ts` already had an `isExpectedOverlap` list for exactly this problem (two pairs); the
flash-swap cluster simply wasn't in it. Added three pairs, and the effect on the **same live data**:

```
before:  P0 0  P1 0  P2 8  P3 89  NOISE 24   top score 50
after:   P0 0  P1 0  P2 0  P3 97  NOISE 24   top score 35
```

The findings did not disappear — the flash swaps still report at P3 as `MANUAL_REVIEW`, at
50→35 and 45→25. Only the manufactured severity went away. A genuine flash-loan exploit still stands
on `FLASH_LOAN_SHAPED` alone and keeps any orthogonal signal: `CAPABILITY_TRANSFER`,
`MUTABLE_REFERENCE_RETURNED`, `ORACLE_MANIPULATION_SUSPECTED` and `UNEXPECTED_TRANSFER` are not in the
overlap list, and a regression test asserts that an orthogonal detector still corroborates all three
cluster members while they do not corroborate each other.

Reproduced by: `npx tsx scripts/agent-tests.ts` → "corroboration independence" (5 checks).

## Scout on live traffic

```
Covered:  1500 listed | 1 analyzed | 85 no target call | 16 system
Coverage: INCOMPLETE — a listing stopped before the checkpoint bound; 1398 of 1500 not reached
Findings: 1  → 9XeGkYN9SPbR… [NOISE] -> DISMISS   (LOW ADDRESS_OUTFLOW, -1000000000000 US)
Budget:   109 RPC, 3 LLM, 103126ms  (reserve held 20 back; verdicts arrived tiered)
```

The scout reached its target, triaged what it found, and **dismissed** it. `investigator.ts` correctly
did not run — nothing reached P0–P2.

**Follow-up, same evening:** the escalation branch has since been exercised end to end. It could not be
reached on organic traffic (nothing in 308 live transactions rose to P0–P2, which is the correct base
rate), so the scout gained `--txs`, an explicit digest list that skips the checkpoint sweep and the
target filter entirely. Over the seven synthetic positive controls it now produces:

```
Scope:    7 explicit transaction(s), 1 pass (no checkpoint sweep)
Coverage: complete — every named transaction reached (no checkpoint sweep was performed)
Findings: 7
  9gwFpqxG… [P0] -> ESCALATE      investigator: suspicious — high-confidence pattern
  AyBucbog… [P1] -> MANUAL_REVIEW investigator: suspicious — high-severity pattern
  7Y3T5H7o… [P2] -> MANUAL_REVIEW investigator: suspicious — high-severity pattern
  GoZD6MFD… [P3] -> MANUAL_REVIEW   (deliberately not investigated)
```

What remains genuinely unproven is narrower and should be stated precisely: the investigator has run on
**synthetic** P0–P2 findings, not on an organic one. On real mainnet traffic the pipeline has so far
produced only LOW/MEDIUM/NOISE, and the first honest interpretation of that is that ordinary Sui
activity is mostly ordinary.

Two implementation notes from the same work, because both are the kind of bug that survives a demo:
the first `--txs` implementation parsed the file and then dropped the list on the way out, so the flag
was silently ignored while the report claimed `Scope: 7 explicit transaction(s)` — caught only by
running it and reading the coverage line, not by reading the code. And an explicit pass initially
seeded the coverage span with `seq 0-0 (1 wide)`, a fabricated range for a run that read no range.
Both are now asserted against in `scripts/agent-tests.ts` (14 checks in "explicit transaction list").

## MCP over stdio, from the published package

`initialize` → `serverInfo: chase 0.1.0/0.1.1`; `tools/list` → **6 tools**
(`chase_analyze`, `chase_query`, `chase_watch`, `chase_triage`, `chase_list`, `chase_hunt`).
Live selftest: 18/18 including a positive control that a target is genuinely present in real
transactions, and that `inspect=0` makes no presence claim.

## Limits this run confirmed rather than assumed

- **Sampling is head-biased.** One listing returns at most 500 with `complete=false`; a 580-checkpoint
  hunt inspected ~6% of what it listed. The tool says `INCOMPLETE`, which is the correct behavior, but a
  hunt is a sample and must be read as one.
- **Target matching is thin in practice.** 86 of 87 inspected transactions did not touch the target; at
  7.4 tx/s a busy protocol is reachable only over narrow ranges or repeated passes.
- **The benign-pattern library matched 0 of 121 live findings.** It does not yet know the Cetus
  `flash_swap → swap_pay_amount → repay_flash_swap` shape that produced every P2 in this run. Suppressing
  it wholesale would be wrong for a real flash-loan attack, which is why the fix was made at the
  corroboration layer instead.
- **Throughput ceiling** is the public fullnode's, not the tool's; a provider endpoint changes it.
