import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";
import { outputOwnerOf, UNRECORDED_NOTE } from "../lib/owner.js";

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

      const owner = outputOwnerOf(change);
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
            recipientKind: owner.kind,
            previousOwner: change.sender ?? null,
          },
        });
        continue;
      }

      // No address owns the object any more. Only claim something when the sender demonstrably
      // held it as an address at input — otherwise nothing about the owner is known.
      if (!senderHeldItBefore) continue;

      const ownerNames = owner.objectId
        ? `${owner.kind} ${owner.objectId.slice(0, 12)}…`
        : owner.kind;

      violations.push({
        type: "UNEXPECTED_TRANSFER",
        severity: "medium",
        message:
          `Object ${change.objectId.slice(0, 12)}… (${shortType(change.objectType)}) left the sender's ` +
          `address ownership into a non-address owner (${ownerNames})`,
        evidence: {
          objectId: change.objectId,
          objectType: change.objectType,
          changeType: change.changeType,
          recipient: null,
          recipientKind: owner.kind,
          ...(owner.objectId ? { recipientObject: owner.objectId } : {}),
          previousOwner: change.sender,
          note:
            owner.kind === "unrecorded"
              ? UNRECORDED_NOTE
              : "recipient is empty because the new owner is not an address owner",
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
