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
    const keys = cmds.map(callKey);

    const firstSeen = new Map<string, number>();
    const prevSeen = new Map<string, number>();

    for (let i = 0; i < cmds.length; i++) {
      const a = keys[i];
      if (!a) continue;

      const start = firstSeen.get(a);
      if (start === undefined) {
        firstSeen.set(a, i);
        prevSeen.set(a, i);
        continue;
      }

      // The call the re-entry actually follows: walk *backwards* from i-1 and take the nearest
      // different function. Scanning forwards from `start` (what this detector used to do)
      // labelled every later repeat with the earliest intervening call, so [a,b,a,c,a] reported
      // both repeats as "intervenedBy b" and mis-described the second one's predecessor.
      let intervening = -1;
      for (let j = i - 1; j > start; j--) {
        const b = keys[j];
        if (b && b !== a) {
          intervening = j;
          break;
        }
      }

      if (intervening === -1) continue;

      const intervenedBy = keys[intervening]!;

      violations.push({
        type: "REENTRANCY_PATTERN",
        severity: "medium",
        message: `${shortKey(a)} re-entered at cmd[${i}] after call to ${shortKey(intervenedBy)} ` +
          `(cmds ${start} -> ${intervening} -> ${i}, previous entry of ${shortKey(a)} at cmd[${prevSeen.get(a)!}])`,
        evidence: {
          function: a,
          firstIndex: start,
          secondIndex: i,
          priorOccurrenceIndex: prevSeen.get(a),
          interveningIndex: intervening,
          intervenedBy,
        },
      });

      prevSeen.set(a, i);
    }

    return violations;
  },
};
