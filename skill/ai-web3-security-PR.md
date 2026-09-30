# Submission, pashov/ai-web3-security

Their `CONTRIBUTING.md` for a free and open source tool is three steps: fork, add the link to the right
section of `README.md`, open a PR with a short description. The stated rules that bite are "web3 security
related", "open source with a public repo", and "keep entries concise, just the name and link".

The section is `Free & Open Source -> Move/Sui`. Its four current entries, verbatim:

```
| [exvulsec/sui-move-skill](...) | Autonomous Sui Move security audit skill for Codex |
| [kaveyjoe/SUIZERO](...) | AI security audits for Sui Move |
| [pantheraudits/move-auditor](...) | Move smart-contract auditor |
| [sanbir/move-auditor-skills](...) | Audit skills for Move contracts |
```

All four describe work on source. The row below matches their length and their tone, and says plainly what
Chase is not, which is a fifth static auditor.

## The row

```markdown
| [0xCyrildev/Chase](https://github.com/0xCyrildev/Chase) | Agentic dynamic analysis of executed Sui Move transactions |
```

## The submitted description

This is the body PR #43 carries as of 2026-09-30, verbatim, after the refresh that replaced the
0.1.1-era numbers. It is longer than their "concise" rule strictly wants; the row above is what the
list actually shows, and the checklist says to trim this to one sentence if a maintainer pushes back
rather than to defend the length.

**Tool:** https://github.com/0xCyrildev/Chase (MIT, public)

**One command, no clone, no key:** `npx -y @zeroxcyril/chase analyze <TX_DIGEST>`, live on npm as `@zeroxcyril/chase` (0.3.0). Any real mainnet digest works, and `npx -y @zeroxcyril/chase triage <digest> --min-tier P2` gives the prioritised view.

The Move/Sui entries here audit source. Chase audits execution. It pulls a transaction's real trace over gRPC from a Sui fullnode, resolves every MoveCall in the PTB, and runs invariant checks on what actually happened. Reverted transactions are analysed in full, because an attempt usually fails somewhere and the attempted call is still the interesting part. This is the phase a source audit cannot observe: after deployment, on a real chain, where the contract may not even be public.

**Three layers, each callable on its own and all of them exposed over MCP (seven tools)**, so an orchestrator routes into whichever one it needs:

- **11 deterministic invariant checks over 12 violation types**: mutable `&mut` returns, capability transfers to a non-participant, oracle update followed by action, unexpected object transfer, A→B→A composition, borrow/repay shape, repeated module calls, address outflow, net coin imbalance summed across the address set, dynamic field create and delete, and an object changing hands with no event naming it.
- **Deterministic triage**: score 0-100, tier P0-P3/NOISE, recommended action (DISMISS / MANUAL_REVIEW / ESCALATE), benign-pattern suppression, per-type confidence modifiers, and a written rationale, so a tier traces back to the weights instead of being taken on faith.
- **A budget-bounded scout**: it takes a mandate, lists transactions, matches a target or an explicit digest list, analyzes, triages, hands P0-P2 to an investigator and decides when to stop, under hard limits on RPC calls, LLM calls, tokens and wall time.

P0-P2 findings escalate to an investigator that *reads* the transaction rather than re-scoring it: one trace fetch, then the commands in order, the packages, the value movement, and the exact names each high-severity signal fired on. The verdict is asked of the decision layer you name, and every reading prints which layer answered. That matters because the two disagree. On one organic mainnet P1 the deterministic layer answered `needs-review`, because all three of its high-severity signals were function-name matches, while a model reading the identical evidence answered `suspicious`. Neither is a vulnerability claim, and the evidence line is what a human checks either way.

Agency is bounded and labelled rather than decorative. A fallback decision prints `[DEGRADED: not a model decision]`. A scan that reached no transactions says `EMPTY AGAINST THE TARGET, not a clean scan`. A run that sampled 500 of several thousand prints `INCOMPLETE`. Digests it could not read come back under `skipped` with a reason, never as an absent finding. The default backend is a deterministic rules table, so a hunt repeats exactly with no key and no spend.

**Limits, stated rather than discovered.** Three detectors are keyword-based and will happily trip legitimate protocols. `ADDRESS_OUTFLOW` is a heuristic, because gRPC balance changes are address-scoped and shared-object flows do not appear there. Public fullnodes prune about three weeks of history unless you point `SUI_RPC_URL` / `SUI_ARCHIVE_URL` at a provider or your own archive. Routed volume is matched against the call, event and object-type positions in a trace, so a protocol reachable only inside another package's internal calls is invisible. And an investigation sees commands, not code: no function signatures, no arguments, so *who can call this and what does it write* stays a Move-source question. Findings are triage signals, not verdicts.

**Evidence.** CI on every push: typecheck plus four suites that run offline against committed traces, needing no `.env` on a fresh clone (12 invariant fixtures, 13 triage cases, 318 regression checks, budget units). Every violation type has a fixture asserting it fires, seven from synthetic Move packages published to testnet and five from organic mainnet transactions, and the docs spell out why those support different claims. A 24-check MCP selftest runs over stdio with no network, 33 with the live mainnet cases. Detection quality is measured instead of argued: `npm run corpus` runs the real pipeline over the local trace cache, offline and repeatably, and it is how the last several detector changes got priced, including two escalations that were caught and suppressed before release. Current measured figures over 6,643 cached mainnet transactions: 896 flagged (13.5%), 16 high-severity findings, 4 transactions at P1, 0 at P0. Field-tested: 3,616 organic transactions swept across the whole retention window.

It also ships as an agent skill under `skill/chase/`: frontmatter and trigger phrases for when an agent should reach for runtime evidence instead of a source audit, the tool table, how to read a coverage line without over-claiming it, and two real hunt reports under `references/`, one that found signals and one that found nothing. The empty one is in there deliberately, because an agent that has only ever seen a successful scan will report an unscanned range as a clean one.

Diff is three lines: the Move/Sui row (sorted by owner, digit-prefixed first, matching the Solidity section), `Move/Sui (4) → (5)`, and the tools badge `89 → 90`.

## Checked before submitting, and what to re-measure before quoting this again

- [x] Public repo, OSI licence (MIT)
- [x] Works without an API key, `npm install -g @zeroxcyril/chase && chase analyze <TX_DIGEST>`
- [x] Live on npm as `@zeroxcyril/chase`. Measured 2026-09-30 at 10:42: the registry serves 0.1.0 through
      0.3.0 with `latest` at 0.3.0, and 0.3.0 was verified as shipped, not just as built: installed into a
      clean prefix, four bins executable, `--version` printing 0.3.0, a live mainnet digest analyzing with
      exit 0, and the published MCP server answering `tools/list` with all seven tools. This is the sentence
      that goes stale first, so re-run `npm view @zeroxcyril/chase version` before quoting any of this again
- [x] Description matches neighbours' length, no marketing superlatives
- [x] The one-command form is the bare `npx -y @zeroxcyril/chase analyze <digest>`, verified against the
      published 0.3.0. Through 0.2.0 that form failed with `Permission denied`, because the bins packed
      without an execute bit and a global install had been hiding it by chmodding its own symlink. The
      `-p @zeroxcyril/chase chase …` form still works and is what to use if a reviewer is on an old version
- [x] Confirmed from the diff itself: the row is the first entry under `Free & Open Source -> Move/Sui`, and `0x…`
      sorting first is what their Solidity section already does (`0xsimao/0xsimao-ai` leads it)
- [ ] One link row only, and resist the temptation to also add it under Multi-Language, since it is Sui specific
- [ ] The star count of the target repo is not a reason to pad the description, their rule is concise, and
      the version above is longer than that rule wants. Trim the Evidence paragraph to a single sentence if a
      maintainer pushes back rather than defending it
- [x] PR #43's stale body (0.1.1, eight invariants, 53 checks) was refreshed on 2026-09-30 with the text above,
      and a comment was posted saying the description changed and the three-line diff did not, because silently
      editing a body three people had already approved is how a review gets tricked

## Why not the skills repo

`pashov/skills` ships Solidity and Foundry skills and its README is scoped to AI-powered Solidity security
skills, so the language fit was wrong even though the format was inviting. `skill/chase/` in this repo is
formatted for that convention anyway, with frontmatter, trigger phrases and `references/`, and it stays
ready in case a Move-specific home opens there. For today, ai-web3-security is the correct target, and it
is an index rather than a code drop, so nothing here needs to move.
