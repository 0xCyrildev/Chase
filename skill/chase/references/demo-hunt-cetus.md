> Captured 2026-09-29 with 0.1.2, verbatim. The investigator output in it is
> superseded — escalated findings now carry an evidence line and name the layer that
> judged them; see `demo-hunt-organic-investigator.md` for current output.

# Chase Hunt Report

**Target:** `0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb`
**Goal:** routed Cetus volume: oracle/flash-loan shapes and unexpected transfers
**Scope:** 120 checkpoints per pass × 1 passes
**Covered:** seq 328337928–328338047 (120 checkpoints wide) · 500 txs listed · 9 analyzed · 161 did not call the target · 27 system txs skipped
**Coverage:** INCOMPLETE — a listing stopped before the checkpoint bound; 303 of 500 listed txs not reached
**Started:** 2026-09-29T16:19:57.295Z
**Duration:** 128877ms

## Usage

| Metric | Value |
|--------|-------|
| RPC calls | 199 |
| LLM calls | 1 |
| Tokens | 500 |

## Decisions

- **stop**: approaching budget limit

## Findings (2)

### `BwoPyAdxHY9e9LXpvsNtDeSyvs72zs2fkmRRCY4iaHFV`

- **Checkpoint:** 328337928

- **LOW** REPEATED_MODULE_CALLS — 0xf7b2b6161a8dae665177efc44d3f0fd3e0131b612237548fca7180097bb3da75::p called 11 times in one PTB
- **LOW** REPEATED_MODULE_CALLS — 0x8eda0e922f48259b97940cc4fa468f2dbe0178da0b91d01957aae97acc20b3b3::vc called 8 times in one PTB
- **MEDIUM** REENTRANCY_PATTERN — vc::qs re-entered at cmd[5] after call to p::av (cmds 1 -> 4 -> 5, previous entry of vc::qs at cmd[1])
- **MEDIUM** REENTRANCY_PATTERN — vc::qs re-entered at cmd[6] after call to p::av (cmds 1 -> 4 -> 6, previous entry of vc::qs at cmd[5])
- **MEDIUM** REENTRANCY_PATTERN — vl::qs re-entered at cmd[7] after call to vc::qs (cmds 3 -> 6 -> 7, previous entry of vl::qs at cmd[3])
- **MEDIUM** REENTRANCY_PATTERN — p::av re-entered at cmd[8] after call to vl::qs (cmds 4 -> 7 -> 8, previous entry of p::av at cmd[4])
- **MEDIUM** REENTRANCY_PATTERN — vc::qs re-entered at cmd[9] after call to p::av (cmds 1 -> 8 -> 9, previous entry of vc::qs at cmd[6])
- **MEDIUM** REENTRANCY_PATTERN — vc::qs re-entered at cmd[10] after call to p::av (cmds 1 -> 8 -> 10, previous entry of vc::qs at cmd[9])
- **MEDIUM** REENTRANCY_PATTERN — vl::qs re-entered at cmd[11] after call to vc::qs (cmds 3 -> 10 -> 11, previous entry of vl::qs at cmd[7])
- **MEDIUM** REENTRANCY_PATTERN — p::av re-entered at cmd[12] after call to vl::qs (cmds 4 -> 11 -> 12, previous entry of p::av at cmd[8])
- **MEDIUM** REENTRANCY_PATTERN — vc::sb re-entered at cmd[19] after call to p::hp (cmds 17 -> 18 -> 19, previous entry of vc::sb at cmd[17])
- **MEDIUM** REENTRANCY_PATTERN — p::hp re-entered at cmd[20] after call to vc::sb (cmds 18 -> 19 -> 20, previous entry of p::hp at cmd[18])
- **MEDIUM** REENTRANCY_PATTERN — p::hp re-entered at cmd[22] after call to vl::sa (cmds 18 -> 21 -> 22, previous entry of p::hp at cmd[20])

### `4JuLFjAs1mQ7zPKhaU7vPzSZyQGysTuSzKGc8doo4Mk6`

- **Checkpoint:** 328337931

- **MEDIUM** REENTRANCY_PATTERN — quote::cetus_b2a re-entered at cmd[5] after call to bisect::advance (cmds 1 -> 4 -> 5, previous entry of quote::cetus_b2a at cmd[1])
- **MEDIUM** REENTRANCY_PATTERN — quote::cetus_b2a re-entered at cmd[6] after call to bisect::advance (cmds 1 -> 4 -> 6, previous entry of quote::cetus_b2a at cmd[5])
- **MEDIUM** REENTRANCY_PATTERN — quote::bolt_buy re-entered at cmd[7] after call to quote::cetus_b2a (cmds 3 -> 6 -> 7, previous entry of quote::bolt_buy at cmd[3])

## Summary

Scanned 0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb over 1 passes spanning seq 328337928..328338047 (120 checkpoints wide; 500 txs listed, 161 did not call the target, 9 analyzed) for goal: "routed Cetus volume: oracle/flash-loan shapes and unexpected transfers". Coverage: INCOMPLETE — a listing stopped before the checkpoint bound; 303 of 500 listed txs not reached. Findings: 2 (REPEATED_MODULE_CALLS=2, REENTRANCY_PATTERN=14). Decision chain: stop. Budget used: 199 RPC, 0 LLM calls, 0 tokens, 128876ms. Findings present. Recommend triage on the returned digests.
