import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

const SUI_TYPE =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export const tokenConservation: InvariantChecker = {
  name: "address-balance-delta",
  description:
    "Flags coin types where an address loses more than it receives within the tx (may indicate shared-object outflow or genuine leak)",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];

    // Group net delta per (address, coinType)
    const netByAddrCoin = new Map<string, Map<string, bigint>>();
    for (const bc of trace.balanceChanges) {
      if (bc.coinType === SUI_TYPE) continue;
      const perAddr = netByAddrCoin.get(bc.owner) ?? new Map<string, bigint>();
      perAddr.set(bc.coinType, (perAddr.get(bc.coinType) ?? 0n) + bc.amount);
      netByAddrCoin.set(bc.owner, perAddr);
    }

    for (const [address, perCoin] of netByAddrCoin.entries()) {
      for (const [coinType, net] of perCoin.entries()) {
        if (net < 0n) {
          violations.push({
            type: "ADDRESS_OUTFLOW",
            severity: "low",
            message: `${address.slice(0, 12)}… net outflow of ${net} ${coinType.split("::").pop()}`,
            evidence: {
              address,
              coinType,
              net: net.toString(),
              note: "May be a shared-object inflow (pool, vault) rather than a bug",
            },
          });
        }
      }
    }

    return violations;
  },
};
