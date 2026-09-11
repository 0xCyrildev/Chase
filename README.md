# Chase

Dynamic analysis tool for Sui Move transactions. Fetches execution traces
via gRPC and runs invariant checks to detect common vulnerability patterns.

```
   ▄████▄   ██░ ██  ▄▄▄       ██████  ▓█████
  ▒██▀ ▀█  ▓██░ ██▒▒████▄    ▒██    ▒  ▓█   ▀
  ▒▓█    ▄ ▒██▀▀██░▒██  ▀█▄  ░ ▓██▄    ▒███
  ▒▓▓▄ ▄██▒░▓█ ░██ ░██▄▄▄▄██   ▒   ██▒ ▒▓█  ▄
  ▒ ▓███▀ ░░▓█▒░██▓ ▓█   ▓██▒▒██████▒▒ ░▒████▒
  ░ ░▒ ▒  ░ ▒ ░░▒░▒ ▒▒   ▓▒█░▒ ▒▓▒ ▒ ░ ░░ ▒░ ░
    ░  ▒    ▒ ░▒░ ░  ▒   ▒▒ ░░ ░▒  ░ ░  ░ ░  ░
  ░         ░  ░░ ░  ░   ▒   ░  ░  ░      ░
  ░ ░       ░  ░  ░      ░         ░      ░  ░
  ░
```

## What it does

Given a transaction digest, Chase:

1. Fetches the full execution trace from a Sui fullnode via gRPC
2. Resolves the signature of every `MoveCall` in the PTB (with caching and retry)
3. Normalizes the response into a stable internal shape
4. Runs a set of invariant checks over the normalized trace
5. Reports findings with severity levels and supporting evidence

Chase is a **dynamic analysis** tool, which means it reasons about what a transaction
actually did on-chain, not what a contract's source code looks like. This is
complementary to static analysis and formal verification, and it catches
classes of issues (unexpected state changes, unexpected transfers, suspicious
call sequences) that source-level tools often miss.

## Install

```bash
git clone https://github.com/0xCyrildev/Chase.git
cd Chase
npm install
cp .env.example .env   # or create your own
```

`.env` needs:

```
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
```

Only `SUI_NETWORK` is currently read — `SUI_RPC_URL` is reserved for a future
configurable-endpoint feature.

## Usage

```bash
# Human-readable report
npm run analyze -- <TX_DIGEST>

# Machine-readable JSON
npm run analyze -- <TX_DIGEST> --json

# Write report to file
npm run analyze -- <TX_DIGEST> --json -o reports/tx.json

# Full debug dump on stderr (commands, balances, events, objects)
npm run analyze -- <TX_DIGEST> --debug
```

Example:

```bash
npm run analyze -- 5RHbYgCHrtpWEWbc46Cj7DLqybY4moKDQUt6DxpmviR7
```

Exit code is `0` when no violations are detected, `1` when at least one fires,
`2` on fetch or runtime error. That makes Chase usable in a shell pipeline:

```bash
if ! npm run analyze -- "$DIGEST" --json > report.json; then
  echo "violations found in $DIGEST"
fi
```

## Invariants

Chase ships with four invariant checks. Each is intentionally conservative —
they fire on patterns worth a human looking at, not on confirmed exploits.

### `address-balance-delta`

Flags coin types where an address has a negative net balance change within a
transaction. Most fires are **benign**: when a coin flows into a shared object
(a pool, a vault, a `Balance<T>` inside a struct), the recipient side doesn't
appear in the address-based `balanceChanges` array, so the sender's debit looks
unmatched.

**Severity:** low

**What a real positive would look like:** a coin type where the total
address-based net across all participants is nonzero *and* no shared object
received the missing amount. Distinguishing these requires reconstructing
object-owned balances, which is on the roadmap.

### `mutable-access`

Flags calls to `public` Move functions that return a `&mut` reference. This
targets the OpenZeppelin-documented bug class where an internal helper is
mistakenly declared `public` instead of `public(package)`, allowing
attacker-deployed modules to obtain mutable references to sensitive objects.

**Severity:** high

**Limitation:** only flags functions whose return type is directly `&mut T`.
The `public(package)` exposure bug can also manifest through indirect access
paths, which this check doesn't see.

### `ownership-anomaly`

Flags object transfers to addresses that did not participate in the
transaction (neither as sender nor as a balance-change owner).

**Severity:** medium

**Limitation:** the `objectType` field on `effects.changedObjects` is often
`"unknown"` because Sui's gRPC response carries object types in a separate map
that Chase doesn't currently join against. The check still functions, but
evidence is weaker than it could be.

### `oracle-pattern`

Flags transactions that call an oracle-update function followed by a DeFi
action (swap, liquidation, borrow, withdraw) in the same PTB. This is a
heuristic for the price-manipulation attack pattern seen in several Sui
incidents.

**Severity:** high

**Limitation:** purely name-based matching against a small keyword list.
Legitimate protocols that update their own oracle then act on it (Chainlink
push feeds, Pyth updates with immediate use) will trip this. Treat as a
triage signal, not a verdict.

## Architecture

```
src/
├── index.ts                    # CLI entry, command parsing
├── commands/
│   └── analyze.ts              # orchestrates fetch → check → report
├── lib/
│   ├── banner.ts               # ASCII banner
│   ├── fetcher.ts              # gRPC fetch + normalize + signature resolver
│   ├── reporter.ts             # human and JSON output
│   └── types.ts                # shared interfaces
└── invariants/
    ├── index.ts                # registry
    ├── token-conservation.ts   # address-balance-delta
    ├── mutable-access.ts       # public &mut return detection
    ├── ownership-anomaly.ts    # unexpected transfers
    └── oracle-pattern.ts       # oracle + DeFi heuristic
```

The fetcher resolves each `MoveCall`'s signature via `getMoveFunction` to
determine `returnsMutableRef`. Results are cached by `(package, module,
function)` for the process lifetime, so a PTB with 20 calls into the same
package performs one signature lookup.

## Known limitations

- **Retention window.** Public fullnodes prune historical transactions.
  Anything older than roughly 21 days returns `NOT_FOUND`. Archival endpoint
  fallback is on the roadmap.
- **System transactions** (sender `0x0000…0000`) are not returned by
  `LedgerService.GetTransaction`.
- **`balanceChanges` is address-scoped.** Shared-object balance changes appear
  as `effects.changedObjects` mutations, not as address deltas. This is the
  root cause of most false positives from `address-balance-delta`.
- **`getMoveFunction` requires one RPC call per unique signature.** Public
  fullnodes rate-limit; a very large PTB touching many packages may exhaust
  the retry budget.
- **No mempool streaming.** One digest per invocation. Batch and streaming
  modes are planned.
  - **Archival fallback is built in.** Chase queries the mainnet fullnode first and
  falls back to `archive.mainnet.sui.io:443` on `NOT_FOUND`. The public archival
  endpoint has strict rate limits; for bulk queries use a paid provider.

## Roadmap

- [ ] Archival endpoint fallback on `notFound`
- [ ] Join `objectTypes` against `effects.changedObjects` so `ownership-anomaly`
      produces typed evidence
- [ ] Reconstruct object-owned balances to fix `address-balance-delta` false
      positives
- [ ] Batch mode: read digests from a file, emit a CSV or NDJSON summary
- [ ] Checkpoint scanner: poll for new checkpoints, run invariants on every
      user transaction, alert on findings
- [ ] Signature cache persistence across runs (SQLite or JSON on disk)
- [ ] Additional invariants:
  - reentrancy-style call patterns (repeated calls to the same module in one PTB)
  - flash-loan-shaped transactions (borrow → action → repay within one PTB)
  - capability-object misuse (unexpected transfers of `TreasuryCap`, `AdminCap`)

## Development

```bash
npm install
npm run analyze -- <DIGEST> --debug   # verify the fetcher works
```

Type checking:

```bash
npx tsc --noEmit
```

Build (produces `dist/`):

```bash
npm run build
npm start -- analyze <DIGEST>
```


## Acknowledgments

The `mutable-access` invariant is inspired by OpenZeppelin's published audit
findings on Sui Move visibility bugs. The `oracle-pattern` heuristic is
modelled on publicly documented Sui DeFi incidents.

## License

MIT — see [LICENSE](LICENSE).
