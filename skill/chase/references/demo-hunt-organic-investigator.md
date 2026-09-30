# Organic traffic, end to end: sweep → P1 → investigator (both layers)

Captured 2026-09-29 with a `0.1.4` build. Input was three transactions selected by sweeping
160 checkpoints spread evenly across the whole public retention window (seq 322845578–328417681),
analyzing 3,616 organic mainnet transactions and keeping the ones triage escalated. Nothing here is
synthetic; nothing here is a vulnerability claim. Reproducing it needs the traces — a fresh run hits
the network, and the retention window keeps moving.

The point of this file is the last two blocks: what a deterministic layer can honestly say about a
P1, and what a model says about the same evidence.

# Chase Hunt Report

**Target:** `explicit:3 tx(s)`
**Goal:** detect suspicious activity
**Scope:** 3 named transaction(s), 1 pass (no checkpoint sweep)
**Covered:** seq n/a–n/a (0 checkpoints wide) · 3 txs listed · 3 analyzed
**Coverage:** complete — every named transaction reached (no checkpoint sweep was performed)
**Started:** 2026-09-29T23:19:13.416Z
**Duration:** 269ms

## Usage

| Metric | Value |
|--------|-------|
| RPC calls | 9 |
| LLM calls | 1 |
| Tokens | 500 |

## Decisions

- **stop**: explicit list of 3 transaction(s) scanned once

## Findings (3)

### `28h3Fe9PrudWzD58e4ukFyLdjzfZHFfP8drAVpyyyoN2`

- **Checkpoint:** explicit-list
- **Tier:** P1
- **Recommended action:** MANUAL_REVIEW
- **Score:** 65
- **Investigator:** needs-review — name match only (rules layer, not a model)
  - read: 28 cmds, 7 pkgs, top 0xe48b33… ×12, succeeded, movement 0x3c0fdd… -16962236 sui::SUI | ORACLE_MANIPULATION_SUSPECTED×3 [0xe48b33…::alpha_lending::update_price, 0xffd405…::router::new_swap_context]
  - Every high-severity signal here fired on a function name: ORACLE_MANIPULATION_SUSPECTED×3. A name match is not a state change — read the left-hand function of each pair to check whether it writes a value the right-hand call consumes. Nothing here is evidence either way.

- **HIGH** ORACLE_MANIPULATION_SUSPECTED — Oracle update at cmd[4] followed by DeFi action at cmd[21]
- **HIGH** ORACLE_MANIPULATION_SUSPECTED — Oracle update at cmd[7] followed by DeFi action at cmd[21]
- **HIGH** ORACLE_MANIPULATION_SUSPECTED — Oracle update at cmd[10] followed by DeFi action at cmd[21]
- **LOW** REPEATED_MODULE_CALLS — 0xe48b33ef41d56e04fc42bf558e4d54d7cae8a363da9054a6c24bafc2c53a4f33::alpha_lending called 12 times in one PTB
- **MEDIUM** REENTRANCY_PATTERN — type_name::get re-entered at cmd[5] after call to alpha_lending::update_price (cmds 2 -> 4 -> 5, previous entry of type_name::get at cmd[2])
- **MEDIUM** REENTRANCY_PATTERN — oracle::get_price_info re-entered at cmd[6] after call to type_name::get (cmds 3 -> 5 -> 6, previous entry of oracle::get_price_info at cmd[3])

… (remaining findings elided; the escalations are quoted in the two sections after this report)

## The investigator, rules layer

```
investigator: needs-review — name match only (rules layer, not a model)
  read: 29 cmds, 5 pkgs, top 0x000000… ×10, succeeded, movement 0xd2c6e3… -4199388 sui::SUI | ORACLE_MANIPULATION_SUSPECTED×3 [0xe48b33…::alpha_lending::update_price, 0x25ebb9…::pool::flash_swap]
  Every high-severity signal here fired on a function name: ORACLE_MANIPULATION_SUSPECTED×3. A name
  match is not a state change — read the left-hand function of each pair to check whether it writes a
  value the right-hand call consumes. Nothing here is evidence either way.
```

Three high-severity oracle signals, and the layer refuses to call that suspicious because it cannot
tell a price write from a feed refresh. That is the correct behaviour for a name match, and it is the
documented false-positive class of this detector.

## The same transaction, read by a model

`chase hunt --txs digests.txt --mode real`:

```
investigator: suspicious — oracle price update followed by flash swap and repayment (read by poolside/laguna-s-2.1:free)
  read: 29 cmds, 5 pkgs, top 0x000000… ×10, succeeded, movement 0xd2c6e3… -4199388 sui::SUI | ORACLE_MANIPULATION_SUSPECTED×3 [0xe48b33…::alpha_lending::update_price, 0x25ebb9…::pool::flash_swap]
  The transaction calls alpha_lending::update_price at cmd[4], cmd[7], and cmd[10], each immediately
  followed by oracle::get_price_info and type_name::get, then executes pool::flash_swap at cmd[11] and
  cmd[14], with pool::repay_flash_swap at cmd[17] and cmd[27]. The oracle update is directly followed by
  a DeFi action (flash_swap) in the same PTB, and value leaves to the sender (0xd2c6e3… receives +2075
  USDC and +9999 DEEP while paying -4199388 SUI). The reentrancy pattern violations and repeated module
  calls reinforce that this structure is not an ordinary feed-refresh-before-withdrawal shape.
```

Same evidence line, different verdict, and both say who wrote them. Neither is a finding: the evidence
carries no function signatures and no arguments, so *who is allowed to call `update_price`, and what it
writes* is answered in the Move source, not here. What the model's sentence did yield was a real gap —
`pool::flash_swap` sits in that evidence while `FLASH_LOAN_SHAPED` stayed silent, because the detector's
borrow keywords had no `flash_swap`. Closing it was measured over 6,502 cached transactions:
90 → 154 `FLASH_LOAN_SHAPED` findings, 10.0% → 10.9% of transactions flagged, high-severity count and
per-transaction P1 count unchanged, every added fire at P3.

## What to copy from this

- Sweep wide → escalate narrow: `--txs` against digests a range actually produced.
- Quote `investigation.evidence`, never `investigation.reasoning`, when you need something checkable.
- A `rules` reading that says `needs-review` is a finished answer about a name match, not a stub.
