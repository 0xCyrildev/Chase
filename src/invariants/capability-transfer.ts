import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";

const CAP_PATTERNS = [
  "::TreasuryCap",
  "::AdminCap",
  "::UpgradeCap",
  "::OwnerCap",
  "::MintCap",
  "::BurnCap",
];

function isCapability(objectType: string): boolean {
  return CAP_PATTERNS.some((p) => objectType.includes(p));
}

export const capabilityTransfer: InvariantChecker = {
  name: "capability-transfer",
  description:
    "Flags transfers of capability objects (TreasuryCap, AdminCap, UpgradeCap, etc.) to addresses other than the transaction sender",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];

    for (const change of trace.objectChanges) {
      if (!change.recipient) continue;
      if (!isCapability(change.objectType)) continue;
      if (change.recipient === trace.sender) continue;

      violations.push({
        type: "CAPABILITY_TRANSFER",
        severity: "high",
        message: `${change.objectType.split("::").slice(-2).join("::")} transferred to ${change.recipient.slice(0, 12)}…`,
        evidence: {
          objectId: change.objectId,
          objectType: change.objectType,
          recipient: change.recipient,
          sender: trace.sender,
        },
      });
    }

    return violations;
  },
};
