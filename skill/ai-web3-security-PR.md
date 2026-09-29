# Submission — pashov/ai-web3-security

Their `CONTRIBUTING.md` for a free/OSS tool is three steps: fork, add the link to the right section of
`README.md`, open a PR with a short description. Guidelines: web3-security related, open source with a
public repo, **entries kept concise — just the name and link**.

The section is `Free & Open Source → Move/Sui`. Its four current entries, verbatim:

```
| [exvulsec/sui-move-skill](...) | Autonomous Sui Move security audit skill for Codex |
| [kaveyjoe/SUIZERO](...) | AI security audits for Sui Move |
| [pantheraudits/move-auditor](...) | Move smart-contract auditor |
| [sanbir/move-auditor-skills](...) | Audit skills for Move contracts |
```

All four describe source-level work. The row below matches their length and tone and says what Chase is
not: another static auditor.

## The row

```markdown
| [0xCyrildev/Chase](https://github.com/0xCyrildev/Chase) | Agentic dynamic analysis of executed Sui Move transactions |
```

## PR description

> **Chase — dynamic analysis for Sui Move**
>
> The Move/Sui entries in this list audit source. Chase audits execution: it pulls a transaction's real
> execution trace over gRPC, resolves every MoveCall in the PTB, and runs invariant checks on what
> actually happened — including transactions that reverted, which is where attempted exploits live.
>
> Three layers, each callable independently and each exposed over MCP so an orchestrator can route into
> them: 8 deterministic invariants → a deterministic triage layer that scores, tiers (P0–P3/NOISE) and
> recommends an action → a budget-bounded scout agent that watches a package across checkpoints and
> decides what to scan and when to stop.
>
> The scout is agentically shaped but the detection stays deterministic: hard limits on RPC calls, LLM
> calls, tokens and wall time; the scan reserves budget so findings get triaged instead of coming back
> untiered; and a fallback decision is printed as `[DEGRADED: not a model decision]` rather than passed
> off as reasoning. Coverage is reported, not assumed — a run that reached 500 of several thousand
> transactions says `INCOMPLETE`, and a target it never matched says `EMPTY AGAINST THE TARGET, not a
> clean scan`.
>
> Honest limits: three detectors are keyword-based and will trip legitimate protocols; `ADDRESS_OUTFLOW`
> is a heuristic because gRPC balance changes are address-scoped; public fullnodes prune ~21 days of
> history; and routed volume is matched against the trace's call/event/object-type positions, so a
> protocol reachable only through another package's internal calls is invisible.
>
> Evidence: public MIT repo, CI on every push (typecheck + two fixture suites), 9 invariant fixtures and
> 10 triage checks that run offline against committed traces, positive controls for all eight detectors
> from synthetic packages published to testnet, and an 18-check live MCP selftest against mainnet.

## Before opening it

- [x] Public repo, OSI licence (MIT)
- [x] Works without an API key (`npm install` → `chase analyze <digest>`)
- [x] Description matches neighbours' length; no marketing superlatives
- [ ] Confirm the row lands under `Free & Open Source → Move/Sui`, alphabetised — `0xCyrildev` sorts first
- [ ] One link row only; resist the temptation to also add it under Multi-Language (it is Sui-specific)
- [ ] Star count of the target repo is not a reason to pad the description — their rule is "concise"

## Why not the skills repo

`pashov/skills` ships Solidity/Foundry skills and its README is scoped to "AI-powered Solidity security
skills". `skill/chase/` in this repo is formatted for that convention (frontmatter, trigger phrases,
`references/`) and stays available if a Move-specific skill home opens there — but ai-web3-security is
the correct target today, and it is an index rather than a code drop, so nothing here needs to move.
