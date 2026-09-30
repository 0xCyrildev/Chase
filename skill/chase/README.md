# Chase

Static analysis tells you what a contract claims. Chase tells you what a transaction did, read out of the
execution trace after the chain actually ran it, including the ones that reverted, which is where the
attempts that did not work live and which is why they are worth a look.

Built for:

- **Audit teams on Sui**, where you hand the agent a digest, or a package to keep an eye on, and get
  runtime behaviour instead of an educated guess about source
- **Protocol teams** watching a deployed package for call shapes that should not be happening at all
- **Researchers** doing post-incident review, including reverted transactions, which are usually the
  interesting ones because an attacker got that far and then hit a requirement

It is not a substitute for the static skills in this library. It is the phase they cannot reach, which is
after deployment, against real execution, where the arguments and return values have already happened.

## What you get

| Layer | Output |
|---|---|
| 11 invariant checks over the gRPC execution trace, producing 12 violation types | violations with severity and evidence, plus the resolved signature of every MoveCall in the PTB |
| Triage | a score from 0 to 100, a tier from P0 through P3 down to NOISE, a `nextAction` of DISMISS, MANUAL_REVIEW or ESCALATE, written rationale showing the arithmetic, benign-pattern suppression, and caveats |
| Scout (`chase hunt`) | a bounded agent that lists checkpoints, matches a target, analyzes, triages, hands P0 to P2 findings to an investigator, and decides when it is done, all under hard budgets on RPC calls, LLM calls, tokens and wall-clock time |
| MCP server | seven tools callable from Claude Code, Cursor, Codex or any orchestrator that can speak stdio, including the investigator on its own (`chase_investigate`), so an agent can read named transactions without running a sweep |

The shape of it is deliberate: deterministic detection, then deterministic triage, then optional model
reasoning on top. The model explains and prioritises what the checks found. It never gets to decide what
fired, which is the same division of labour the rest of this library uses.

## Demo

Real output, not staged. A synthetic public `&mut` return, published to testnet, analyzed from a
committed trace with no network access:

```
$ chase triage 9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg --network testnet

Summary
   P0  1   P1 0   P2 0   P3 0   NOISE 0

Findings

   P0  MUTABLE_REFERENCE_RETURNED  score=80
  digest:  9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg
  sender:  0x4e7a16d751af45ed77...
  0x10172126bb0bc55e32dea70a223b7590da2eecf6a1b40bb2c353f1d750f12405::leak::leak_mut returns a mutable reference to the calling transaction; no other non-framework package is invoked in this PTB
  rationale: MUTABLE_REFERENCE_RETURNED (high) base=60 · +20 confidence · = 80
  action: ESCALATE
```

Add `--explain` and the same finding gets prose it can stand behind:

> This finding signals that the function `leak_mut` in the `leak` module returns a mutable reference to
> the calling transaction, and no other non-framework package is invoked in this PTB. However, since no
> other non-framework packages are involved, the risk is limited to the scope of this single package.

The more useful demonstration is the one where the tool does not flatter itself. A bounded hunt over live
mainnet Cetus volume flagged a DEX router doing quote-bisection, which is exactly the false-positive class
the reentrancy detector documents, so the report printed its coverage line admitting that a listing stopped
early and the score carried a -10 for name-based firing instead of pretending the pair of findings was a
catch. The verbatim run is in `references/demo-hunt-cetus.md`, and next to it sits
`references/demo-hunt-cetus-empty-before-fix.md`, which is the same target returning nothing at all while a
broken target matcher made a busy protocol look quiet. Both are real, and the second one is kept because a
tool that only preserves its successes is telling you something.

For organic traffic and the investigator there is
`references/demo-hunt-organic-investigator.md`: three escalations out of 3,616 mainnet transactions swept
across the whole retention window, and the same evidence read twice. The deterministic layer answered
`needs-review`, because every high severity signal in it was a function-name match, and a model reading the
identical line of facts answered `suspicious`. Each reading prints which layer wrote it, and that
disagreement is precisely why neither one gets to be called a vulnerability. The file also says what a human
would have to read to settle it.

## Install and run

Published, which is the short version:

```bash
npm install -g @zeroxcyril/chase
chase analyze <TX_DIGEST>
```

Or without installing anything, which is what a reviewer tends to want:

```bash
npx -y -p @zeroxcyril/chase chase analyze <TX_DIGEST>
npx -y -p @zeroxcyril/chase chase triage <TX_DIGEST>
npx -y -p @zeroxcyril/chase chase-hunt --target <package_id> --mode rules
npx -y -p @zeroxcyril/chase chase-mcp
```

Keep the `-p` in there. The package installs four commands, so npx needs to be told which one you mean
before it will act as a package runner. Up to and including 0.2.0 the shorter form did not merely fail, it
failed with `Permission denied`, because the build emitted its bin files without an execute bit and npm
packed the modes it was given. Fixed in 0.2.1, with a test over the modes, on the grounds that a quickstart
which does not run is indistinguishable from a tool that does not work.

MCP, against the published package:

```bash
claude mcp add --transport stdio --scope user chase -- npx -y -p @zeroxcyril/chase chase-mcp
```

From a checkout instead, which is identical apart from length and the fact that you can read the source
while it runs:

```bash
git clone https://github.com/0xCyrildev/Chase.git && cd Chase && npm install
cp .env.example .env          # optional, nothing in it is needed to analyze a transaction
npx tsx src/index.ts analyze <TX_DIGEST>
claude mcp add --transport stdio --scope user chase -- npx tsx /path/to/Chase/src/mcp-server.ts
```

## Proof it works

- `npm test` runs four suites, all offline against committed traces: 12 invariant fixtures, 13 triage
  cases, 318 regression checks, and budget unit checks. The regression suite covers target matching, budget
  reservation, the corroboration independence rules, the whole scan to triage to escalate chain including
  the investigator's reading, the batch output contract, CLI argument validation, dry-run coverage,
  manifest and lockfile agreement, the owner-kind vocabulary, a real cache round trip, the watch cursor
  store, and the watch loop driven against a fake checkpoint listing, bounded ranges included.
- Every violation type has a committed trace asserting it fires. Seven types come from a synthetic Move
  package published to testnet, whose source ships under `test-cases/synthetic-leak/`. Five come from
  organic mainnet transactions, because a synthetic trigger would overstate what those checks prove, and an
  organic case is a characterisation control rather than a demonstration that the detector catches exploits.
- `npm run mcp:selftest` runs 24 checks over stdio with no network, covering all seven tools, and
  `npm run mcp:selftest:live` runs 33 against mainnet, including a positive control that a target really
  is found in real transactions.
- `npm run smoke:live` analyzes uncached transactions from a current checkpoint, which is the only thing
  that can notice a retention window change, a gRPC shape break, or an endpoint that stopped answering.
- Detection quality is measured instead of asserted. `npm run corpus` runs the full pipeline over every
  trace in the local cache, offline and repeatably, and prints the flag rate, the worst tier per
  transaction, and a per-type breakdown. That is how the last several detector changes got priced, and
  twice it caught a new low-severity check quietly escalating someone else's finding, which is documented
  in `reports/0.2.0-detector-pricing.md` rather than quietly fixed.
- Field tested on live traffic: 308 transactions at 7.4 per second with zero fetch or detector errors,
  8.1% flagged, and triage producing no false P0 or P1 over the flagged set. The same run surfaced a real
  scoring flaw, where one flash swap was being counted as three independent detectors agreeing, and fixing
  it moved 8 P2 findings to 0 and the top score from 50 to 35 without hiding any of them. That report is
  `reports/field-test-2026-09-29.md`.
- The published artifact gets checked as shipped, not as committed: install into a clean prefix, run every
  bin, confirm the version the binary reports, and confirm a dry run says `NO SCAN RAN` instead of claiming
  a complete sweep, which is the bug that escaped in 0.1.0.
- CI runs typecheck plus all four suites on every push.

## Read this before trusting it

- Three detectors are keyword-based, namely `oracle-pattern`, `flash-loan-shaped` and
  `capability-transfer`, so legitimate protocols trip them on a good day. A tier is triage input, not a
  finding, and the tool prints that distinction rather than leaving it to you.
- `ADDRESS_OUTFLOW` is a heuristic, because gRPC balance changes are address scoped and shared-object flows
  do not appear in them at all.
- Public fullnodes prune roughly three weeks of history, so an old digest returns `not found`. The public
  archive endpoint answers without a token, contrary to what this README used to claim, and it also
  returns `not found` for pruned digests, so the fallback recovers nothing. `SUI_RPC_URL` and
  `SUI_ARCHIVE_URL` are how you actually go back in time.
- Whether a package is present is not free. The gRPC listing filter silently under-matches, and it reported
  a busy DEX package as never called, so Chase lists without that filter and confirms presence by reading
  traces. A `chase_list` result with `inspect=0` makes no presence claim whatsoever.
- A wide checkpoint range is sampled from its head, at 500 transactions per listing call, and the report
  says `INCOMPLETE` when it did not reach the bound. Several narrow ranges beat one wide one at the same
  budget.
- Presence matching has a ceiling that is structural. It reads top-level call packages, event type prefixes
  and object type prefixes, so a protocol reached only through another package's internal calls, with no
  type appearing in events or object changes, is invisible here, and "not found" must never be reported as
  "not called".
