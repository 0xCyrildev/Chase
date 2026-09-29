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

---

# Follow-up, same day: organic traffic, and what the investigator actually was

## The wide sweep

The 308-transaction run above was a head sample of one checkpoint range. This one spread 160
checkpoints evenly across the whole retention window (seq 322845578–328417681, 5,572,103 checkpoints
wide), de-duplicated to 4,198 unique transactions, and analyzed what the fullnode still had:

```
retention window: lowest=322845578 current=328417681 (5572103 checkpoints); sampled 160 spread evenly -> 4198 unique txs

== 3616 organic txs in 394s (9.2/s) | reverted 303 | flagged 382 (10.6%) | HIGH/CRITICAL-or-signature hits 3 ==
system 571 | notfound 0 | errors 11
   545  REENTRANCY_PATTERN
   258  REPEATED_MODULE_CALLS
    68  ADDRESS_OUTFLOW
    59  FLASH_LOAN_SHAPED
    10  ORACLE_MANIPULATION_SUSPECTED
     2  UNEXPECTED_TRANSFER
```

Three candidates surfaced, all of them on `ORACLE_MANIPULATION_SUSPECTED`, none reverted. Two numbers
worth keeping: 9.2 tx/s sustained against the public fullnode, and 11 errors out of 3,616 — of which
nine were `RpcError` with an **empty message**, which is to say the tool could tell that something
failed and nothing about what. That is now wrapped as
`gRPC RpcError <code> — <details> while reading <digest>`.

## The investigator was not investigating

Pointing `chase hunt --txs` at those three candidates produced a verdict for each, and the verdicts
were worthless:

```
investigator: suspicious — high-severity pattern
  Triage assigned tier P1. At least one high-severity violation present.
```

Reading the code explained it. `investigate()` re-analyzed the digest (a second fetch), re-ran triage
on it (a third), and then selected a sentence from a table keyed on the tier triage had already
assigned. It never read anything triage had not already counted, and it never asked the decision
layer a question — `--mode real` and `--mode rules` produced the identical string. It also did not
record which layer had answered, so a table lookup was indistinguishable from a model's judgement in
the JSON. Every escalated finding cost four calls to restate one.

What it does now: one trace read, then a structured account of what the transaction contains —
commands in order, packages by call count, largest coin movements, transfers, events, and the exact
function names each high-severity detector matched, with identical firings collapsed to one counted
signal. The verdict is asked of the decision layer over that evidence, and the layer is recorded.
Detector evidence is carried on the finding instead of being re-derived, because dropping it at the
scan boundary is what forced the re-analysis in the first place.

The deterministic layer is now explicitly not allowed to sound like a judgement: when every
high-severity signal rests on a function name — which is what all three organic candidates turned out
to be — it answers `needs-review` and names what to read next.

```
investigator: needs-review — name match only (rules layer, not a model)
  read: 29 cmds, 5 pkgs, top 0x000000… ×10, succeeded, movement 0xd2c6e3… -4199388 sui::SUI | ORACLE_MANIPULATION_SUSPECTED×3 [0xe48b33…::alpha_lending::update_price, 0x25ebb9…::pool::flash_swap]
  Every high-severity signal here fired on a function name: ORACLE_MANIPULATION_SUSPECTED×3. A name
  match is not a state change — read the left-hand function of each pair to check whether it writes a
  value the right-hand call consumes. Nothing here is evidence either way.
```

`--mode real`, same transaction, same evidence:

```
investigator: suspicious — oracle price update followed by flash swap and repayment (read by poolside/laguna-s-2.1:free)
  … calls alpha_lending::update_price at cmd[4], cmd[7], and cmd[10], each immediately followed by
  oracle::get_price_info and type_name::get, then executes pool::flash_swap at cmd[11] and cmd[14],
  with pool::repay_flash_swap at cmd[17] and cmd[27] … value leaves to the sender (0xd2c6e3… receives
  +2075 USDC and +9999 DEEP while paying -4199388 SUI) …
```

Two findings from that pair, both kept deliberately visible:

- **The layers disagree on identical evidence.** That is the reason provenance is printed on every
  reading rather than only when a layer fails. Neither answer is a vulnerability; the model's is a
  hypothesis about commands it can see, and the evidence carries no function signatures or arguments,
  so *who controls the price* is still unanswered.
- **The model's sentence exposed a detector gap.** `pool::flash_swap → pool::repay_flash_swap` was
  sitting in the evidence while `FLASH_LOAN_SHAPED` stayed silent: `BORROW_KEYWORDS` had `borrow`,
  `flash_loan`, `flashloan`, `loan` — and Cetus's entry point is named neither. (Section above: the
  same shape was already known as the source of every P2 in the 308-tx run, where it was handled at
  the corroboration layer. Handling it there was right; being blind to it was not.)

## Pricing the detector fix, offline

`scripts/corpus-report.mjs` runs the invariant + triage pipeline over every trace in the local cache —
6,502 mainnet transactions, no RPC, repeatable. Before/after, produced by swapping the compiled
keyword list and rebuilding:

| | before | after |
|---|---|---|
| `FLASH_LOAN_SHAPED` findings | 90 | 154 |
| transactions with any finding | 652 (10.0%) | 707 (10.9%) |
| high-severity findings | 16 | 16 |
| worst tier per tx | P1=4 P3=277 NOISE=371 | P1=4 P3=335 NOISE=371 |

Every added fire landed at P3. Manual-review load did not move; a pattern that was invisible is now
visible at the lowest useful tier. Borrow/repay names observed across the corpus after the change,
which is the real shape of what got picked up:

```
flash_swap_with_partner/repay_flash_swap_with_partner=47, flashloan_quote/return_flashloan_quote=27,
borrow_flashloan_base/return_flashloan_base=24, flash_swap/repay_flash_swap=16,
borrow_flashloan_quote/repay_flash_swap=12, … deepbook_flash_borrow_base/deepbook_flash_repay_base=2
```

A bare `flash_swap → repay_flash_swap` pair with no action in between still does not fire, by design;
that would flag ordinary use of a flash-swap primitive. Asserted in the offline suite.

## Two measurement traps hit while doing this

- **A stale `dist/` prints plausible output.** `npm run build 2>&1 | tail -3` reports the exit code of
  `tail`, not of `tsc`. That mattered twice: once when a build had genuinely failed on
  `rules-llm.ts(126)` while I was already reading investigator output from the *previous* binary — it
  looked correct and was stale — and once when an error appeared in a piped build log that a clean
  re-run did not reproduce, which is a bad reason to trust either result. Every build check from here
  on is `>file 2>&1; echo EXIT=$?`, and the claim being tested is re-checked against the compiled
  file, not against the last run.
- **`cp` is aliased to `-i` here.** A `cp` meant to restore a file prompted, got no input, and did
  nothing — silently leaving `dist/` on the pre-change detector. Restoring state is verified by
  grepping the file afterwards, not by assuming the copy happened.
