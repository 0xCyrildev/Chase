import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

const SYSTEM_SENDER = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const mutableAccess: InvariantChecker = {
  name: "mutable-access",
  description:
    "Flags cross-package calls that obtain mutable references (public vs public(package) bug class)",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const sender = trace.sender;

    if (!sender || sender === "unknown" || sender === SYSTEM_SENDER) return violations;

    for (const cmd of trace.ptbCommands) {
      if (cmd.kind !== "MoveCall" || !cmd.returnsMutableRef) continue;
      violations.push({
        type: "MUTABLE_REFERENCE_RETURNED",
        severity: "high",
        message: `${cmd.packageId}::${cmd.module}::${cmd.function} returns a mutable reference`,
        evidence: {
          caller: sender,
          package: cmd.packageId,
          module: cmd.module,
          function: cmd.function,
          commandIndex: cmd.index,
        },
      });
    }

    return violations;
  },
};
