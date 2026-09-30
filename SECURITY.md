# Security policy

Chase is an analysis tool for Sui Move transactions. It runs locally, holds no secrets, talks to public
chain endpoints, and parses data that somebody else put on a blockchain. That combination has a specific
security surface, and this file says what counts as a problem in it.

## Report a vulnerability in Chase

Open a private security advisory on the repository: [github.com/0xCyrildev/Chase/security/advisories/new](https://github.com/0xCyrildev/Chase/security/advisories/new).

If that is not convenient, email the address on the project's npm package page with the word `chase` in
the subject. There is no published PGP key, so do not send anything that depends on transport encryption
being verified.

Please include, in whatever order is useful:

- what input you gave it (a digest, a JSON report, a mandate file, an agent tool call)
- what happened, with the command line you used
- what you expected to happen instead
- whether the tool read something it should not have, wrote somewhere it should not have, or let
  untrusted content influence a decision or a prompt

## What counts as a security issue here

1. **Path handling.** Chase turns digests into cache filenames. A digest can arrive from a CLI flag, a
   JSON report produced by another tool, or an agent's tool call, so a malformed one is hostile input by
   default. Anything that escapes `~/.cache/chase/<network>/` or writes outside the configured state
   directory is a bug. `src/lib/digest.ts` exists for this reason, and a way around it is a vulnerability.
2. **Prompt injection through trace content.** Function names, module names, object type strings and event
   JSON in a transaction are authored by whoever submitted that transaction. The investigator feeds a model
   the normalised evidence it assembled itself (counts, short names, amounts) and not raw trace JSON, and the
   detector verdict is decided deterministically before any model is asked. If you can make a model's prose
   say something the evidence does not support, by naming a function artfully for instance, that is a real
   finding.
3. **A report that overstates its coverage.** This one is a correctness bug normally, not a security bug. It
   becomes a security bug when the overstatement can be *induced* by the transaction under analysis, because
   then whoever writes that transaction is choosing what your monitoring tells you. An example that qualifies:
   a transaction shape that makes a scan reporting "clean" actually be reporting "did not look".
4. **Credential handling.** `LLM_API_KEY`, `SUI_RPC_URL` and `SUI_ARCHIVE_URL` are read from the
   environment. Any path that logs one of those values, writes one into a report or artifact, or sends it
   somewhere the user did not configure is a bug.

## What is not a security issue

- **A finding Chase raised about your protocol.** That is the tool working, and it is often a false
  positive: three detectors are keyword-based on purpose, and the low-severity shape checks fire on
  ordinary traffic at measured rates. The right response is the benign-pattern library in
  `src/triage/benign-patterns.json`, and the tier and its arithmetic are in the report so you can see why
  it scored what it did. Open an ordinary issue, and include the digest.
- **The public endpoints being rate limited, slow, or pruning history.** Public fullnodes prune about
  three weeks and Chase reports what it could not read. Point `SUI_RPC_URL` at your own provider.
- **Anything requiring you to already control the machine.** Read access to `~/.cache/chase`,
  `$XDG_DATA_HOME/chase/` or `~/.npmrc` is read access to the user's files, and no finding is interesting
  there.
- **Findings about a smart contract.** Chase is not the target and this is not a bounty program for the Sui
  chains it analyses. A vulnerability report about a protocol belongs to that protocol's programme.
- **A dependency advisory** on something in `package-lock.json`. Open a normal issue. A pull request is
  more than fine.

## Expectations, both directions

There is no service level agreement here and no bug bounty, because this is an MIT-licensed tool and not a
company. What you can expect is a response on the advisory within a few days, and a fix shipped in a patch
release if the thing is real. What Chase expects from you is the smallest reproduction that proves it, and
no exploitation of a live protocol while demonstrating one. The tool's own rules, which are printed in its
README, apply to reporting about it: show the input, show the output, do not upgrade "this looked odd" into
"this is vulnerable".

## Preferred disclosure

90 days from the advisory to whatever you want published, or earlier if you say so. If a release fixes
something without naming it, ask on the advisory and the write-up will come.
