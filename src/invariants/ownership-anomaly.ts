import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

export const ownershipAnomaly: InvariantChecker = {
  name: "ownership-anomaly",
  description:
    "Flags object transfers to addresses that did not participate in the transaction",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const participants = new Set<string>([trace.sender]);
    trace.balanceChanges.forEach((b) => participants.add(b.owner));

    for (const change of trace.objectChanges) {
      if (change.changeType === "transferred" && change.recipient) {
        if (!participants.has(change.recipient)) {
          violations.push({
            type: "UNEXPECTED_TRANSFER",
            severity: "medium",
            message: `Object ${change.objectId} transferred to non-participant ${change.recipient}`,
            evidence: {
              objectId: change.objectId,
              recipient: change.recipient,
            },
          });
        }
      }
    }

    return violations;
  },
};
