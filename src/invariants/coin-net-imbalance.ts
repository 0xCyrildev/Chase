import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";
import { normalizeAddress } from "../lib/target.js";

const FRAMEWORK = normalizeAddress("0x2")!;
const SUI_COIN = `${FRAMEWORK}::sui::SUI`;

/**
 * `balanceChanges` is keyed by address. Sum a coin type across every address in the transaction and
 * the total should be zero — unless value crossed the boundary of what that view can see, which is
 * what a deposit into (or withdrawal from) a shared object's internal balance looks like.
 *
 * This is NOT a supply-change check and does not claim one. On 6,502 cached mainnet transactions the
 * non-zero totals are dominated by `provide_liquidity`, `open_position` and `claim_rewards` — money
 * moving somewhere this trace cannot name, not money appearing.
 */
export const coinNetImbalance: InvariantChecker = {
  name: "coin-net-imbalance",
  description:
    "Reports a coin type whose amounts do not sum to zero across the addresses in the transaction, " +
    "value that entered or left the address-visible set, which is where shared-object balances live",
  emits: [{ type: "COIN_NET_IMBALANCE", severity: "low" }],
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    if (trace.balanceChanges.length === 0) return violations;

    const byCoin = new Map<string, Map<string, bigint>>();
    for (const b of trace.balanceChanges) {
      // Gas. Including it is not a judgement call about relevance: the same rule fires on 71.6% of
      // mainnet transactions with SUI counted and 2.9% without, and 4,466 of those fires are gas
      // alone. The exclusion is what keeps this a signal rather than a traffic counter.
      if (b.coinType === SUI_COIN) continue;
      const perOwner = byCoin.get(b.coinType) ?? new Map<string, bigint>();
      perOwner.set(b.owner, (perOwner.get(b.owner) ?? 0n) + b.amount);
      byCoin.set(b.coinType, perOwner);
    }

    const calls = nonFrameworkCalls(trace);

    for (const [coinType, perOwner] of byCoin) {
      const entries = [...perOwner.entries()];
      const net = entries.reduce((acc, [, v]) => acc + v, 0n);
      if (net === 0n) continue;

      const debited = entries.filter(([, v]) => v < 0n).map(([o]) => o);
      const credited = entries.filter(([, v]) => v > 0n).map(([o]) => o);
      const shown = entries
        .sort((a, b) => (a[1] < b[1] ? -1 : 1))
        .slice(0, 8)
        .map(([owner, amount]) => ({ owner, net: amount.toString() }));

      violations.push({
        type: "COIN_NET_IMBALANCE",
        severity: "low",
        message:
          `${shortType(coinType)}: ${net > 0n ? "+" : ""}${net} unaccounted for across ` +
          `${entries.length} address(es); value ${net > 0n ? "entered" : "left"} the address-visible set`,
        evidence: {
          coinType,
          net: net.toString(),
          direction: net > 0n ? "entered the address-visible set" : "left the address-visible set",
          debitedAddresses: debited,
          creditedAddresses: credited,
          perAddress: shown,
          perAddressTruncated: entries.length > shown.length,
          nonFrameworkCalls: calls.slice(0, 6),
          nonFrameworkCallCount: calls.length,
          suiExcluded: true,
          balanceChangeRowCount: trace.balanceChanges.length,
          note:
            "not a supply change: a non-zero total is what value crossing into or out of a shared " +
            "object's internal balance looks like in an address-scoped balanceChanges. The object " +
            "side is not in this trace, so this names a candidate mechanism (see nonFrameworkCalls), " +
            "not a leak.",
        },
      });
    }

    return violations;
  },
};

function nonFrameworkCalls(trace: SuiTransactionTrace): string[] {
  const out: string[] = [];
  for (const cmd of trace.ptbCommands ?? []) {
    if (!cmd.function) continue;
    const pkg = normalizeAddress(cmd.packageId ?? "");
    if (!pkg || pkg === FRAMEWORK || pkg === normalizeAddress("0x1") || pkg === normalizeAddress("0x3")) {
      continue;
    }
    out.push(`${cmd.module ?? "?"}::${cmd.function}`);
  }
  return out;
}

function shortType(t: string): string {
  const parts = t.split("::");
  return parts.length >= 2 ? `${parts[parts.length - 2]}::${parts[parts.length - 1]}` : t;
}
