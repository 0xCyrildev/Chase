import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

// Framework modules that are called repeatedly by design (coin splits, merges,
// vector ops, tx_context reads). Suppress these to avoid noise.
const SYSTEM_MODULES = new Set([
  "0x0000000000000000000000000000000000000000000000000000000000000001::vector",
  "0x0000000000000000000000000000000000000000000000000000000000000002::coin",
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui",
  "0x0000000000000000000000000000000000000000000000000000000000000002::balance",
  "0x0000000000000000000000000000000000000000000000000000000000000002::transfer",
  "0x0000000000000000000000000000000000000000000000000000000000000002::tx_context",
  "0x0000000000000000000000000000000000000000000000000000000000000002::object",
  "0x0000000000000000000000000000000000000000000000000000000000000002::dynamic_field",
  "0x0000000000000000000000000000000000000000000000000000000000000002::dynamic_object_field",
]);

// Aggregator/router packages that call the same module repeatedly as part of normal multi-hop
// routing. This list is deliberately EMPTY: no package has yet been verified as a router from
// real watch output, and inventing package ids would suppress findings nobody has checked.
// Consequence: no router suppression happens today — the only excluded modules are the
// SYSTEM_MODULES above, and the detector description says exactly that. Add entries from observed
// routing in `chase watch` output, not from guesses.
const KNOWN_ROUTERS = new Set<string>([
  // leave empty for now — populate from watch findings
]);

const THRESHOLD = 5;

export const repeatedModuleCalls: InvariantChecker = {
  name: "repeated-module-calls",
  description: `Flags PTBs that call into the same non-system module ${THRESHOLD}+ times`,
  emits: [{ type: "REPEATED_MODULE_CALLS", severity: "low" }],
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const counts = new Map<string, number>();

    for (const cmd of trace.ptbCommands) {
      if (cmd.kind !== "MoveCall" || !cmd.packageId || !cmd.module) continue;
      const key = `${cmd.packageId}::${cmd.module}`;
      if (SYSTEM_MODULES.has(key)) continue;
      if (KNOWN_ROUTERS.has(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const [key, count] of counts.entries()) {
      if (count >= THRESHOLD) {
        violations.push({
          type: "REPEATED_MODULE_CALLS",
          severity: "low",
          message: `${key} called ${count} times in one PTB`,
          evidence: { module: key, count },
        });
      }
    }

    return violations;
  },
};
