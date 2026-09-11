import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

export const ownershipAnomaly: InvariantChecker = {
  name: "ownership-anomaly",
  description:
    "Flags object transfers to address owners that did not participate in the transaction",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const participants = new Set<string>([trace.sender]);
    trace.balanceChanges.forEach((b) => participants.add(b.owner));

    for (const change of trace.objectChanges) {
      // Only address-owned outputs are meaningful for this check
      if (!change.recipient) continue;
      // Skip if the recipient participated
      if (participants.has(change.recipient)) continue;
      // Skip the sender itself (self-transfer to sender's own address is fine)
      if (change.recipient === trace.sender) continue;

      violations.push({
        type: "UNEXPECTED_TRANSFER",
        severity: "medium",
        message: `Object ${change.objectId.slice(0, 12)}… (${shortType(change.objectType)}) transferred to non-participant ${change.recipient.slice(0, 12)}…`,
        evidence: {
          objectId: change.objectId,
          objectType: change.objectType,
          recipient: change.recipient,
        },
      });
    }

    return violations;
  },
};

function shortType(t: string): string {
  const parts = t.split("::");
  return parts.length >= 2 ? `${parts[parts.length - 2]}::${parts[parts.length - 1]}` : t;
}
