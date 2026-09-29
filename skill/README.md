# Submission packaging

Two different repos, two different kinds of deliverable. Both were checked against the target's own
`CONTRIBUTING.md` rather than assumed.

| Target | What it actually wants | Here |
|---|---|---|
| [pashov/ai-web3-security](https://github.com/pashov/ai-web3-security) | a **link list**. One concise row in `Free & Open Source → Move/Sui`, plus a short PR description | `ai-web3-security-PR.md` |
| [pashov/skills](https://github.com/pashov/skills) | a **skill directory**: `SKILL.md` with YAML frontmatter and trigger phrases, `README.md`, `references/`, `scripts/`; `VERSION` is bumped by their CI | `chase/` |

Start with the hub: it is the smaller ask, it is where a Sui/Move dynamic analyzer is a genuine gap, and
it is the collection Pashov referenced when he said the tool needed agency in it.

`chase/` is staged so it can be copied into a fork of `pashov/skills` as a top-level `chase/` directory
unchanged. Its demo blocks were re-run and pasted verbatim, because their contribution rules say *"no
fabricated examples — outputs must reflect real model responses"*; the empty scan alongside the run that
found signals is deliberate, not an oversight.

Not yet done for the skills repo: a row in their root README's Skills table, and a real load test in VS
Code/Cursor — the stdio server is verified by `npm run mcp:selftest`, those clients are not. The
`scripts/` wrapper their skills ship is now present (`chase/scripts/chase-analyze.sh`).
