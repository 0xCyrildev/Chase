# Chase

Static analysis tells you what a contract **says**. Chase tells you what a transaction **did**.

Built for:

- **Audit teams** on Sui — hand the agent a digest, or a package to watch, and get runtime behaviour
  instead of a source-only guess
- **Protocol teams** monitoring a deployed package for call patterns that should not be happening
- **Researchers** doing post-incident review — including the transactions that reverted, which are
  attempted exploits and are usually the most interesting ones

Not a replacement for static skills. It is the phase they cannot cover: after deployment, against real
execution.

## What you get

| Layer | Output |
|---|---|
| 8 invariant checks over the gRPC execution trace | violations with severity, evidence, and the resolved signature of every MoveCall in the PTB |
| Triage | score 0–100, tier `P0`–`P3`/`NOISE`, `nextAction` (`DISMISS`/`MANUAL_REVIEW`/`ESCALATE`), written rationale, benign-pattern suppression, caveats |
| Scout (`chase hunt`) | a bounded agent that lists checkpoints, matches a target, analyzes, triages, escalates P0–P2 to an investigator, and decides when to stop — under hard RPC/LLM/token/wall-clock budgets |
| MCP server | six tools callable from Claude Code, Cursor, Codex or any orchestrator |

The split is deliberate: **deterministic detection → deterministic triage → optional LLM reasoning.** The
LLM explains and prioritises; it does not decide what fired. Same shape as the rest of this library.

## Demo

Real output, no staging. A synthetic public `&mut` return published to testnet:

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

With `--explain`, the same finding gets prose it can defend:

> This finding signals that the function `leak_mut` in the `leak` module returns a mutable reference to
> the calling transaction, and no other non-framework package is invoked in this PTB. … However, since no
> other non-framework packages are involved, the risk is limited to the scope of this single package.

A bounded hunt over live mainnet Cetus volume — note what the coverage line admits:

```
Covered:  seq 328337928–328338047 (120 checkpoints wide) | 500 listed | 9 analyzed | 161 no target call | 27 system
Coverage: INCOMPLETE — a listing stopped before the checkpoint bound; 303 of 500 listed txs not reached
Findings: 2 (REPEATED_MODULE_CALLS=2, REENTRANCY_PATTERN=14)
Budget used: 199 RPC, 0 LLM calls, 0 tokens, 128876ms
```

Those two findings are a DEX router doing quote-bisection — the false-positive class the reentrancy
detector is documented to have, which is why it carries a −10 confidence modifier. **Chase surfaced them
and named its own uncertainty.** That is the intended behaviour, not a success story, and the full report
is included at `references/demo-hunt-cetus.md` — along with
`references/demo-hunt-cetus-empty-before-fix.md`, the same target returning nothing before the target
matcher was fixed. Both are real runs.

## Install and run

```bash
git clone https://github.com/0xCyrildev/Chase.git && cd Chase && npm install
cp .env.example .env          # optional; nothing in it is required to analyze
npx tsx src/index.js analyze <TX_DIGEST>
```

MCP:

```bash
claude mcp add --transport stdio --scope user chase -- npx tsx /path/to/Chase/src/mcp-server.ts
```

## Proof it works

- `npm test` → four suites: 9 invariant fixtures + 10 triage checks + 61 regression checks
  (target matching, budgets, corroboration independence, the scan→triage→escalate chain including the
  investigator's verdict, batch contract, CLI validation, dry-run coverage) + budget unit checks — all
  **offline** against committed traces
- All eight detectors have positive controls: synthetic Move packages published to testnet that fire each
  detector on demand (the Move package ships in the Chase repo under `test-cases/synthetic-leak/`)
- `npm run mcp:selftest:live` → 18 checks against live mainnet, including a positive control that a
  target is actually found in real transactions
- **Field-tested on live mainnet:** 308 transactions analyzed uncached at 7.4 tx/s with zero fetch or
  detector errors; 8.1% flagged; triage over the flagged set produced 0 false P0/P1 and 24 dismissals,
  and the run found a real scoring flaw (a flash swap counted as "3 independent detectors agreeing")
  which was fixed and re-measured on the same traffic — 8 P2 → 0, top score 50 → 35, nothing hidden.
  See `reports/field-test-2026-09-29.md` in the repo
- CI on every push: typecheck plus all four suites

## Read this before trusting it

- Three detectors are **keyword-based** (`oracle-pattern`, `flash-loan-shaped`, `capability-transfer`);
  legitimate protocols trip them. A tier is triage input, not a finding.
- `ADDRESS_OUTFLOW` is a heuristic, because gRPC balance changes are address-scoped and shared-object
  flows do not appear there.
- Public fullnodes prune ~21 days of history, so old digests return `not found`.
- Presence of a package is **not** free: the gRPC listing filter silently under-matches (it reported a
  busy DEX package as never called), so Chase lists unfiltered and verifies presence by reading traces.
  A `chase_list` result with `inspect=0` makes no presence claim at all.
- A wide checkpoint range is sampled at its head (500 transactions per listing) and the report says
  `INCOMPLETE` when it did not reach the bound.
