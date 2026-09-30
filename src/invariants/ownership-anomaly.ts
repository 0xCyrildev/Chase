import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";
import { outputOwnerKind } from "../lib/owner.js";

export const ownershipAnomaly: InvariantChecker = {
  name: "ownership-anomaly",
  description:
    "Flags pre-existing objects whose ownership moved to an address that did not participate in the " +
    "transaction, or out of the sender's address ownership into a non-address owner",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const participants = new Set<string>([trace.sender]);
    trace.balanceChanges.forEach((b) => participants.add(b.owner));

    for (const change of trace.objectChanges) {
      // An object created by this transaction was not transferred — it came into existence here.
      // Only a pre-existing object changing hands is an ownership anomaly.
      if (change.changeType === "created") continue;
      // A deleted object has no recipient; ownership ends instead of moving.
      if (change.changeType === "deleted") continue;
      if (change.changeType !== "mutated") continue;

      const ownerKind = outputOwnerKind(trace, change);
      const senderHeldItBefore = !!change.sender && change.sender === trace.sender;

      if (change.recipient) {
        if (participants.has(change.recipient)) continue;

        violations.push({
          type: "UNEXPECTED_TRANSFER",
          severity: "medium",
          message: `Object ${change.objectId.slice(0, 12)}… (${shortType(change.objectType)}) ${
            change.changeType
          }: transferred to non-participant ${change.recipient.slice(0, 12)}…`,
          evidence: {
            objectId: change.objectId,
            objectType: change.objectType,
            changeType: change.changeType,
            recipient: change.recipient,
            recipientKind: ownerKind,
            previousOwner: change.sender ?? null,
          },
        });
        continue;
      }

      // No address owns the object any more. Only claim something when the sender demonstrably
      // held it as an address at input — otherwise nothing about the owner is known.
      if (!senderHeldItBefore) continue;

      violations.push({
        type: "UNEXPECTED_TRANSFER",
        severity: "medium",
        message:
          `Object ${change.objectId.slice(0, 12)}… (${shortType(change.objectType)}) left the sender's ` +
          `address ownership to a non-address owner (${ownerKind})`,
        evidence: {
          objectId: change.objectId,
          objectType: change.objectType,
          changeType: change.changeType,
          recipient: null,
          recipientKind: ownerKind,
          previousOwner: change.sender,
          note:
            "recipient is empty because the new owner is not an AddressOwner; the normalized trace " +
            "does not name the owning object",
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
