# Chase Hunt Report

**Target:** `0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb`
**Goal:** oracle manipulation and flash-loan-shaped flows
**Scope:** 5 checkpoints per pass × 3 passes
**Covered:** seq 328332009–328332014 (6 checkpoints wide) · 0 txs listed · 0 analyzed
**Coverage:** complete — every listed transaction reached, to the checkpoint bound
**Control:** the filtered listing matched nothing, yet the same range does contain transactions — the target was not reached by a top-level MoveCall here.
**Started:** 2026-09-29T15:57:18.724Z
**Duration:** 3162ms

## Usage

| Metric | Value |
|--------|-------|
| RPC calls | 9 |
| LLM calls | 4 |
| Tokens | 2000 |

## Decisions

- **continue**: scanning with current filter
- **continue**: scanning with current filter
- **stop**: no findings in three consecutive iterations

## Findings (0)

No findings.
## Summary

Scanned 0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb over 3 passes spanning seq 328332009..328332014 (6 checkpoints wide; 0 txs listed, 0 analyzed) for goal: "oracle manipulation and flash-loan-shaped flows". Coverage: complete — every listed transaction reached, to the checkpoint bound. Findings: 0 (none). Decision chain: continue -> continue -> stop. Budget used: 9 RPC, 3 LLM calls, 1500 tokens, 3161ms. This was an EMPTY SCAN, not a clean one: no transaction matched the target filter.
