import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

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

function callKey(cmd: any): string | null {
  if (cmd.kind !== "MoveCall" || !cmd.packageId || !cmd.module || !cmd.function) return null;
  const moduleK = `${cmd.packageId}::${cmd.module}`;
  if (SYSTEM_MODULES.has(moduleK)) return null;
  return `${moduleK}::${cmd.function}`;
}

function shortKey(key: string): string {
  return key.split("::").slice(-2).join("::");
}

export const reentrancyPattern: InvariantChecker = {
  name: "reentrancy-pattern",
  description:
    "Flags A -> B -> A call sequences where the same function is re-entered after an intervening call to a different function",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const cmds = trace.ptbCommands;

    const firstSeen = new Map<string, number>();

    for (let i = 0; i < cmds.length; i++) {
      const a = callKey(cmds[i]);
      if (!a) continue;

      if (!firstSeen.has(a)) {
        firstSeen.set(a, i);
        continue;
      }

      const start = firstSeen.get(a)!;
      let sawOther = false;
      let otherKey = "";

      for (let j = start + 1; j < i; j++) {
        const b = callKey(cmds[j]);
        if (b && b !== a) {
          sawOther = true;
          otherKey = b;
          break;
        }
      }

      if (sawOther) {
        violations.push({
          type: "REENTRANCY_PATTERN",
          severity: "medium",
          message: `${shortKey(a)} re-entered after call to ${shortKey(otherKey)} (cmds ${start} -> ${i})`,
          evidence: {
            function: a,
            firstIndex: start,
            secondIndex: i,
            intervenedBy: otherKey,
          },
        });
      }
    }

    return violations;
  },
};
