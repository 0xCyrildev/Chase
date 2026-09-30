# Contributing

Chase is a small tool with one demanding requirement, and it is not code style. Every claim it makes has to
point at the thing that measured it. A tier is a triage signal, a clean report is a statement about one
transaction, and a rate quoted in a README has to have a denominator next to it. Most of the guidance below
exists because that standard has been violated here in ways that produced wrong results, not hypothetical
ones, and the fixes are all in the git log.

## The commands to know

```bash
npm install          # also builds: `prepare` runs the build, and the bins execute dist/
npm run typecheck    # tsc --noEmit over src/ only, see the trap below
npm test             # four suites, all offline against committed traces
npm run mcp:selftest # the MCP contract, offline, over stdio: see the section below
npm run smoke:live   # three uncached mainnet transactions: the only check that sees transport drift
npm run corpus -- <label>   # price a detector or scoring change over the local trace cache
```

`npm run corpus` must be run through npm, not as `node scripts/corpus-report.mjs`. The script imports the
source tree via tsx on purpose. It used to import `dist/`, which meant it measured whatever was last built
rather than whatever you just changed, and a fresh detector produced a byte-identical report. That looks
exactly like a null result, which is why it survived until someone compared counts instead of trusting one.

## Before you add or change a detector

Run `npm run corpus -- before`, make the change, run `npm run corpus -- after`, and put the real numbers in
the pull request. This is the step that has caught something every single time it has been done, including
twice in one pass where a new low-severity check was quietly escalating *other* findings from P3 to P2 by
agreeing with them, which is not what a new detector is supposed to do and is not visible in any unit test.

Deciding a detector's shape means deciding three things, and there are two separate mechanisms for the last
one:

1. Its severity, and its `confidenceModifier` in `src/triage/triage.config.json`. A `0` has to be written
   down as a `0`; the scorer's fallback for a missing key is also `0`, which is why an unconfigured type is
   invisible rather than loud.
2. Whether it re-expresses a construct another detector already describes. If yes, add the pair to
   `EXPECTED_OVERLAP` in `src/triage/enrich.ts`, because agreement between two names for one shape is one
   opinion.
3. If no, but it fires on a large share of ordinary traffic, declare `corroborates: false` on the emission
   instead. That means "reported, never used to raise priority". Do not solve a noisy detector by pairing it
   against four unrelated types. `EXPECTED_OVERLAP` means "same construct" and nothing else, and using it to
   mean "hush" makes the corroboration table lie about the detectors.

Then declare what it emits. `InvariantChecker.emits` is required, so `tsc --noEmit` fails the moment a
checker emits a type that nobody configured, which is the compile-time version of the same rule as point 1.
The gate in `scripts/agent-tests.ts` then insists that every emitted type has a config entry, exactly one
owner, a row in the README's modifier table, a section under the README's `### <checker>` headings, and a
fixture that shows it firing, or an entry in a deliberately empty allowlist that prints in the failure
message. Do not add to that allowlist to get green. It is empty right now because all twelve types have a
control, and the two kinds of control are different claims: seven types come from the synthetic Move package
published to testnet, five from organic mainnet transactions, and an organic case proves the detector fires
on real data of that shape, not that it catches an exploit.

## Changing the MCP surface

`src/mcp-server.ts` is a contract with software that is not yours, so it has its own test:

```bash
npm run mcp:selftest          # offline, against committed fixtures, no endpoint needed
CHASE_MCP_LIVE=1 npm run mcp:selftest   # adds the live listing, watch and hunt cases
```

Three rules the test enforces, all of them learned the hard way:

- **A tool must accept what its documentation says it accepts.** `skill/chase/SKILL.md` once listed
  `useCache`, `explain`, `txs` and `reserveForJudge` as inputs that did not exist, and the investigator
  itself was not callable over MCP at all. When the doc and the tool disagree, decide which one is the
  spec before editing either, and prefer fixing the tool if the documented behaviour is the useful one.
- **Anything a caller could mistake for a clean result has to be named.** Return `skipped` or `notRead`
  with a per-item reason. An absent finding and a transaction with nothing to report are the same JSON
  shape to a program, which is the same failure as `complete` on a scan that ran no passes.
- **Structured output keeps its provenance.** A reading prints which layer formed it, so `source`,
  `model` and `degraded` stay on the response rather than being flattened into prose on the way out.

Adding a tool also means updating the tool lists in `README.md`, `skill/chase/SKILL.md` and
`skill/chase/README.md`, and the count the selftest asserts. Three places, and CI will not notice if you
miss one, which is exactly why the count is asserted rather than admired.

## Tests

The suites are offline and stay offline. `run-tests.sh` and `run-triage-tests.sh` export
`CHASE_CACHE_DIR=test-cases/fixtures`, the triage suite also pins `CHASE_HISTORY_FILE=""`, and
`agent-tests.ts` pins `CHASE_WATCH_CURSOR_FILE=""` as well. Never point a fixture suite at a live endpoint,
and never conclude from a green fixture suite that the transport, the retention window or the gRPC response
shape still work, because fixtures cannot see any of that. That is what `npm run smoke:live` is for.

Mutable state goes in `$XDG_DATA_HOME/chase/`, never in `CHASE_CACHE_DIR`. The suites aim the cache
directory at the committed fixtures, so a state file written there gets edited by the tests that read it,
and a store a test mutates is not a fixture. Anything new that writes state has to be disableable by
setting its environment variable to the empty string, in both directions, like triage history and the watch
cursor already are.

A test that passes on an empty set of inputs is not a test. Where a check iterates declarations, add the
anti-vacuity case, which is what the `emits` gate does with its non-empty requirement and its allowlist.
Where a check asserts that some misleading phrase is *absent*, retarget the phrase whenever the wording
changes, or the assertion turns quietly true.

## Things that have already fooled someone here

- **A pipe reports the wrong exit code.** `npm run build 2>&1 | tail -3` returns `tail`'s status, so a
  failed compile reads as success and the previous `dist/` keeps printing plausible output. Redirect to a
  file and echo `$?`.
- **`scripts/` is never typechecked.** `tsconfig.json` includes `src/**` only, and the suites run through
  `tsx`, which strips types without checking them. So a green `npm test` says nothing about buildability,
  and a changed `src` signature is caught by reading call sites, not by CI. When a check can be expressed in
  typed `src`, express it there.
- **`cp` and `mv` are aliased to `-i` on at least one development machine here.** A scripted restore printed
  a prompt, got no answer, and did nothing, mid-experiment, while the file stayed broken. Verify a restore by
  reading the file afterwards.
- **A zero-padded Sui address literal typed by hand can be short by a few hex characters**, and in a
  framework *exclusion* that fails toward over-firing rather than crashing. It moved some measured rates by
  nineteen percentage points. Use `normalizeAddress` and `moveTypePackage` from `src/lib/target.ts`, which
  pad correctly.
- **A tool output string can look like a fact about a chain.** `complete` on a scan that ran no passes, a
  `RpcError` with an empty message that turns nine unreadable transactions into silence, `not found` that
  means "wrong network" rather than "pruned". These were all real, all fixed, and all invisible until the
  output was read closely.
- **`npm pack --dry-run` does not show file modes.** The bins shipped without an execute bit through four
  releases because a global install chmods its own symlink and hides the problem, while `npx` execs the file
  from the cache. Check a real tarball with `tar -tzvf`.

## Changing the watcher

Four rules in `src/commands/watch.ts` and `src/lib/cursor.ts` are load-bearing, and each one exists
because the opposite behaviour was observed:

- The stored position is the **next checkpoint to attempt**, written only after every transaction in a
  checkpoint was tried. Never write it mid-loop, and never for a checkpoint that threw.
- An unreadable checkpoint advances the position *and* appends to `gaps`. A gap that is not recorded is
  coverage the run never had, and the next run has to be able to say how many there are.
- A range that reaches the endpoint's tip re-checks it once and then stops. Walking past it would print
  `0 txs` for checkpoints that do not exist yet, advance over them, and leave a monitor reporting a
  sweep the chain never had. Exiting 2 there is correct: the range was asked for and not delivered.
- A resume below the retention floor exits instead of clamping forward, and `--from` never rewinds the
  stored cursor. Both of those turn one command into another command, and printing a number is not
  consent to a three-week backfill.

The cursor is written as a temp file plus a rename, because a torn cursor reads as no cursor and resumes
from tip-2 in silence. Its tests pin `CHASE_WATCH_CURSOR_FILE` to a temp path; the state store a suite
mutates is not a fixture, and the live position belongs to whoever is running a monitor.

## Publishing

Only a human can publish, and that is not a workaround, it is the account's two-factor configuration. Run
`npm publish` in a terminal, press ENTER at the prompt or paste the printed URL into a browser that is
signed in, and complete the passkey step. `--otp` cannot work: this account has a passkey and no TOTP
secret. A non-interactive `npm publish` exits with `EOTP` after printing the URL rather than waiting for
you. The registry's reads lag a fresh publish by several minutes, so poll the tarball endpoint before
concluding that it failed, and expect `prepare` to rebuild `dist/` as part of the publish itself.

`package.json` and `package-lock.json` must change together and agree on name and version, because CI's
`npm ci` refuses a lock whose root self-reference does not match. Splitting the two produced a red run in
the middle of a release once. The version `chase --version` prints is read from `package.json` at runtime,
so there is one place to bump and no second file to remember.

## House rules

One logical change per commit, and a message that says what was wrong and what happens now rather than what
was touched. Past tense, specific, and long enough to be useful to whoever wonders in six months.

`AGENTS.md` in this directory is project memory and is gitignored. Do not commit it, do not push it, and if
you change something it asserts, re-measure the assertion instead of inheriting it. That file has been wrong
in ways that mattered, and so has this one, which is the honest reason both exist.
