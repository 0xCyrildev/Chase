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

## PR description

> **Chase, dynamic analysis for Sui Move**
>
> The Move and Sui entries in this list audit source. Chase audits execution. It pulls a transaction's real
> execution trace over gRPC, resolves every MoveCall in the PTB, and runs invariant checks over what
> actually happened, including transactions that reverted, which is where attempted exploits tend to sit.
>
> Three layers, each callable on its own and all of them exposed over MCP so an orchestrator can route into
> whichever one it needs: eleven deterministic invariants, then a deterministic triage layer that scores,
> tiers and recommends an action, then a budget-bounded scout agent that watches a package across
> checkpoints and decides what to scan and when to stop.
>
> The scout is agentically shaped while the detection stays deterministic. There are hard limits on RPC
> calls, LLM calls, tokens and wall time, the scan holds part of its budget back so findings come back
> triaged rather than untiered, and a fallback decision prints as `[DEGRADED: not a model decision]` rather
> than being passed off as reasoning. Coverage gets reported rather than assumed, so a run that reached 500
> of several thousand transactions says `INCOMPLETE`, and a target it never matched says `EMPTY AGAINST THE
> TARGET, not a clean scan`.
>
> P0 to P2 findings escalate to an investigator that reads the transaction instead of re-scoring it. One
> trace fetch, then the commands in order, the packages, the value movement, and the exact function names
> each high severity signal matched. The verdict is asked of the decision layer over that evidence, which
> means a rules table by default with no key and no spend, or a model on request, and every reading prints
> which layer wrote it. That matters because the two disagree. On one organic mainnet P1 the deterministic
> layer answered `needs-review`, because all three of its high severity signals were function-name matches,
> while a model reading the same evidence answered `suspicious`. Neither is a vulnerability claim, and the
> evidence line is what a human checks either way.
>
> Limits, stated rather than discovered: three detectors are keyword-based and will happily trip legitimate
> protocols, `ADDRESS_OUTFLOW` is a heuristic because gRPC balance changes are address scoped, public
> fullnodes prune about three weeks of history unless you point `SUI_RPC_URL` or `SUI_ARCHIVE_URL` at a
> provider or your own archive, and routed volume is matched against the call, event and object type
> positions in the trace, so a protocol reachable only inside another package's internal calls is invisible.
>
> Evidence: public MIT repo. CI on every push, running typecheck plus four suites that are all offline
> against committed traces, with 12 invariant fixtures, 13 triage cases and 258 regression checks. Every
> violation type has a fixture asserting it fires, seven from synthetic packages published to testnet and
> five from organic mainnet transactions, and the difference between those two kinds of control is spelled
> out in the docs because they support different claims. There is a 9-check MCP selftest over stdio and an
> 18-check live variant, a smoke test against uncached mainnet transactions, and detection quality is
> measured rather than argued: 3,616 organic mainnet transactions swept across the retention window, and a
> 6,500-transaction offline corpus run is how the last few detector changes got priced, including two
> escalations that were caught and reverted before release.
>
> One command, no clone, no key: `npm install -g @zeroxcyril/chase && chase analyze <TX_DIGEST>`

## Before opening it

- [x] Public repo, OSI licence (MIT)
- [x] Works without an API key, `npm install -g @zeroxcyril/chase && chase analyze <TX_DIGEST>`
- [x] Live on npm as `@zeroxcyril/chase`, currently serving 0.1.0 through 0.2.0, each verified by installing
      from the registry into a clean prefix and running the bins, so a reviewer can try it in one command
      instead of cloning. 0.2.1 is committed and waiting on a publish grant, and it only fixes the execute
      bit on the bin files, so nothing in this description depends on it
- [x] Description matches neighbours' length, no marketing superlatives
- [x] The no-install form uses `npx -y -p @zeroxcyril/chase chase …`, because four bins ship in one package
      and the bare form is a question npx cannot answer
- [ ] Confirm the row lands under `Free & Open Source -> Move/Sui`, alphabetised, with `0xCyrildev` sorting first
- [ ] One link row only, and resist the temptation to also add it under Multi-Language, since it is Sui specific
- [ ] The star count of the target repo is not a reason to pad the description, their rule is concise, and
      the version above is longer than that rule wants. Trim the Evidence paragraph to a single sentence if a
      maintainer pushes back rather than defending it

## Why not the skills repo

`pashov/skills` ships Solidity and Foundry skills and its README is scoped to AI-powered Solidity security
skills, so the language fit was wrong even though the format was inviting. `skill/chase/` in this repo is
formatted for that convention anyway, with frontmatter, trigger phrases and `references/`, and it stays
ready in case a Move-specific home opens there. For today, ai-web3-security is the correct target, and it
is an index rather than a code drop, so nothing here needs to move.
