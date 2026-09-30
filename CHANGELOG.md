# Changelog

The rule for this file is the rule for the tool: a number here has a measurement behind it, and the
measurement says what it was taken over. Corpus figures come from `npm run corpus`, which runs the real
invariant and triage pipeline over the local mainnet trace cache offline, with the novelty history disabled
so two runs compare.

## 0.3.0

**The investigator is callable, the watch position is a thing you can look at, and the MCP surface says
what its own documentation already promised.**

0.2.3 was committed and never published, so its one line ships here too: the failed-analysis coverage
hint used to state "every listed digest failed, which is what a list spanning two networks looks like"
as a fact about the cause. This release's own example had a different cause (retention, the testnet
transactions are simply gone), so the wording now says *also*, which names the axis a reader needs
without asserting a diagnosis the trace cannot see.

- **`chase_investigate`, a seventh MCP tool.** Reading P0 to P2 transactions was the scout's private
  business: an orchestrator could ask for analysis, triage, a listing, a watch range or a hunt, and
  could not ask "read these three digests the way the escalated path reads one". It costs one trace
  fetch per digest, returns the commands in order, the packages by call count, the coin movements, what
  changed hands, the names each high-severity signal fired on, and the verdict with `source` attached so
  a rules-table answer cannot be quoted as a model's. `mode` picks the layer. A digest with nothing to
  read is returned under `notRead` with its reason rather than going missing, because an absent finding
  and a clean transaction look identical to anything automating this.
- **Three documented MCP inputs that did not exist now do.** `chase_triage` accepts `explain` and returns
  the `skipped` list its own skill documentation promised; `chase_hunt` accepts `txs` and
  `reserveForJudge`; `chase_analyze` honours `useCache`. The `txs` path is the one that mattered: post-
  incident review hands an agent digests, not a package to sweep, and until now the only way to get that
  reading through MCP was a live checkpoint hunt.
- **`chase watch --to <seq>` bounds a range, and refuses to pretend about the tip.** A range that runs
  past the endpoint's tip used to be walkable: the loop would list checkpoints that do not exist yet,
  print 0 txs for each and advance the cursor over them, which is a monitor recording coverage the chain
  never had. It now re-checks the tip when it reaches the edge (so a chain that catches up mid-run is
  used rather than assumed), stops, names the part it could not scan, leaves the cursor at the first
  unread checkpoint and exits 2. `--to` before the start is refused outright, since a run that scans
  nothing while printing a tidy summary is the one report format that lies. `--limit` cutting a range
  short stays exit 0: that is a stop you asked for.
- **`chase watch --status` and `--reset-cursor`.** The position an interrupted monitor saved was
  invisible except by watching the next run resume. `--status` prints the file it read, the next
  checkpoint, when it was saved and how many gaps are recorded, and makes no network call, so the
  question stays answerable while the endpoint is down. `--reset-cursor` forgets one network's position,
  prints what it removed and the `--from` value that would recover it, never deletes a store it could not
  parse (the other networks live in that same file), and passing it together with `--status` is refused,
  because one is a question and the other is a deletion. `chase cache` prints the same state read-only,
  and `chase cache --clear` says plainly that it did not touch it.
- One validation path that called `process.exit` directly now goes through the injected `exit` seam, so
  the offline watch tests can see the same refusal a user sees.
- Regression checks 274 → 318, and the MCP selftest went from 9 offline checks to 24 (33 with
  `CHASE_MCP_LIVE=1`). The new coverage is the cursor store and its reset paths, bounded `--to` ranges
  driven through the fake ledger including the tip re-check, and the investigation surviving an MCP
  round trip with its evidence and its provenance intact, which was the last layer of this tool that no
  automated test had ever read.
- Detection output is unchanged, and this time it was measured rather than asserted. The local cache is a
  living corpus (it stood at 6,643 mainnet traces after this release's own live `chase watch` proof), so
  comparing against a row from an earlier run says nothing. Instead: `npm run corpus` from this tree, and the
  same command from a worktree of the previous commit, over the identical cache. Both printed
  896 flagged transactions (13.5%), 2,256 findings, worst tier per transaction P1=4 P2=0 P3=407 NOISE=485,
  16 high-severity findings and the same ten per-type counts, line for line. Nothing in this release touches
  an invariant or a scoring rule, and that is now a measurement instead of a promise.

## 0.2.2

**Output that says which chain it read, and no dashes in the tool's own voice.**

- A hunt run against a `--txs` list spanning two networks analyses every digest on the mandate's single
  network, so the digests from the other chain fail as `not found`. That reads exactly like the retention
  window and is not it. The coverage line now names the network, and when every listed digest failed it says
  what that pattern usually means. The hunt report header states the network in both the CLI and the
  Markdown form, and `coverage.network` is on the JSON for agents.
- Every user-facing string the tool prints lost its em dashes, so quoted output in the documentation is
  dash-free without anyone retouching a transcript to get there.
- 263 regression checks, up from 258.

## 0.2.1

**The published binaries are executable.**

`tsc` emits at 0644, npm packs the modes it is handed, and `npx -y @zeroxcyril/chase <cmd>` execs the file
straight out of its cache, so the documented one-liner failed with `Permission denied` while every global
install check passed, because npm sets the bit on the symlink it makes. The build now marks the bin targets
from `package.json`'s own `bin` map and fails if a declared target is missing, and the suite asserts mode,
existence and shebang per declared bin. Verified against a real tarball with `tar -tzvf`, since
`npm pack --dry-run` never shows modes.

## 0.2.0

**The roadmap pass: eleven detectors, a watch cursor, cached traces that answer what a live trace
answered, and two escalations caught before they shipped.**

Breaking for library consumers, which is what the minor bump is for: `raw` is gone from
`SuiTransactionTrace` and `emits` is required on `InvariantChecker`.

Detectors:

- `coin-net-imbalance` sums each coin type across the addresses in a transaction and reports a non-zero
  total, which is what value crossing into or out of a shared object's internal balance looks like in an
  address-scoped `balanceChanges`. 189 of 6,502 transactions (2.91%) against 122 (1.88%) for the
  per-address rule it sits beside. Excluding `0x2::sui::SUI` carries the measurement rather than a
  preference: with gas counted the same rule fires on 71.59% of traffic, and 4,466 of those fires are gas
  alone.
- `dynamic-field-lifecycle` reports `Field` objects created or destroyed, 128 and 58 transactions
  (1.97%, 0.89%), and deliberately not mutated, which is 3,807 transactions and 14,497 of 14,816 field
  changes. The checker's own description carries the excluded number.
- `silent-object-change` reports a sender-held object mutated or destroyed while no event in the transaction
  came from the package that owns its type, checked against both the event type and the event `packageId`,
  because those disagree after a package upgrade. 38 transactions (0.58%). The wide "the transaction emitted
  nothing" shape is 588 transactions (9.04%) and 39.14% of all traffic emits nothing, so that one is printed
  as an observation in the report rather than scored.

Correctness:

- Output-owner kinds are recorded on each object change at fetch time and cached with it. Two ownership
  rules had been reading `trace.raw`, which `saveTrace` never wrote, so on every cached path, meaning all
  fixtures, the whole corpus, and any second look at a digest, the non-address half of both rules could only
  answer `unresolved`. `raw` is gone from the trace type. `unresolved` (looked, cannot classify, usually a
  deleted object) and `unrecorded` (normalised before capture, nobody looked) are now distinct, with the
  second one naming `--no-cache` as the way to resolve it.
- `src/lib/owner.ts` is the single owner vocabulary, and it maps the five shapes the SDK actually emits.
  Both rules previously switched on `Parent` and `DerivedAddress`, which appear nowhere in `mapOwner`, while
  falling through on the real `ConsensusAddressOwner`, so that kind read as unowned even on a live first
  fetch. Sampling 875 fresh mainnet transactions found no example of it, so this is a blind spot closed and
  asserted, not a fix demonstrated on traffic.
- `chase watch` remembers the last checkpoint it finished, per network, in `$XDG_DATA_HOME/chase/`, written
  as a temporary file and renamed. It keeps a ledger of checkpoints whose listing failed rather than absorbing
  them into coverage, refuses to clamp a cursor that fell below the retention floor, refuses to wait for a tip
  the endpoint has not reached, does not rewind for a `--from` run, and prints a coverage summary on Ctrl-C
  before exiting 130.
- `build` removes `stale dist/` before compiling. `tsc` never deletes an output file and the package ships
  all of `dist`, so a deleted module keeps publishing its compiled corpse.
- `chase cache --clear` sweeps what it used to leave behind: checkpoint listings, and 1,042 loose traces
  written before records were namespaced by network.
- `src/agent/checkpoint-cache.ts` deleted. It had no importers, so its five-minute TTL had never
  governed anything, while it had already written 44 files into a real cache.

Scoring:

- Corroboration got two mechanisms instead of one being asked to do both jobs. `EXPECTED_OVERLAP` means two
  types describe the same construct. `corroborates: false` on an emission means reported, and never used to
  raise priority, which is what a shape appearing in 2% of ordinary traffic deserves. Shipping
  `COIN_NET_IMBALANCE` with only the first mechanism moved 4 transactions from P3 to P2, and shipping
  `DYNAMIC_FIELD_CREATED` the same way moved 2 already-P1 transactions' reentrancy findings to P2. Both were
  caught by pricing and reverted before release; `reports/0.2.0-detector-pricing.md` has the per-commit
  numbers, ending at 888 of 6,576 transactions flagged with no P2 anywhere.

Tooling:

- Every detector declares the types it emits in a required, typechecked field, and a gate asserts that each
  emitted type has a deliberate triage entry, one owner, a README section, a README modifier-table row, and a
  fixture. It also scans each detector file's source, so an undeclared new emission in an existing checker
  fails. Verified by deleting a config key on purpose and watching the suite name it.
- The measurement instrument was fixed before its readings were trusted: `corpus-report.mjs` imported
  `dist/`, so it priced the last build rather than the working tree.
- `npm run corpus` is the documented entry point, and `chase cache` reports what it reclaimed.

## 0.1.x

Published as 0.1.0, 0.1.1, 0.1.2 and 0.1.3. Described coarsely on purpose, because the version bumps and
the commits were not kept in step and a changelog that guesses is worse than one that says so.

- 0.1.0 shipped a hunt report that described a scan which ran no passes as `complete`, every listed
  transaction reached. Fixed in 0.1.1, which now prints `NO SCAN RAN` and `NOTHING SCANNED`, alongside a
  `chase --version` that had been reporting a stale number because the version lived in two places.
- Corroboration was counting one construct as three independent detectors, which turned two Cetus flash
  swaps into eight P2 findings across 308 live mainnet transactions. Fixed by collapsing corroborating
  violations to one opinion per distinct type: P2 went 8 to 0 and the top score 50 to 35, with the findings
  still visible at P3.
- `flash_swap` was missing from the flash-loan borrow keywords, so Cetus's own idiom read as three unrelated
  calls. Adding it moved 90 findings to 154 and the flag rate from 10.0% to 10.9% over 6,502 cached
  transactions, with high-severity and P1 counts unchanged.
- 0.1.4 was prepared with configurable endpoints, self-naming gRPC errors and the investigator rewrite, and
  was never published. Its contents shipped in 0.2.0, so 0.1.4 is skipped permanently rather than reserved.
