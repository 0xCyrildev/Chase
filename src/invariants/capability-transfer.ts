import { InvariantChecker, ObjectChange, SuiTransactionTrace, Violation } from "../lib/types.js";
import { outputOwnerOf, UNRECORDED_NOTE } from "../lib/owner.js";

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

function shortCapName(objectType: string): string {
  for (const p of CAP_PATTERNS) {
    if (objectType.includes(p)) return p.replace("::", "");
  }
  return objectType.split("::").pop() ?? objectType;
}

function typeKnown(change: ObjectChange): boolean {
  return !!change.objectType && change.objectType !== "unknown";
}

function coverageOf(trace: SuiTransactionTrace) {
  const unresolvedObjectTypes = trace.objectChanges.filter((c) => !typeKnown(c)).length;
  const capabilities = trace.objectChanges.filter((c) => typeKnown(c) && isCapability(c.objectType));

  return {
    classifier: "objectType",
    unresolvedObjectTypesInTrace: unresolvedObjectTypes,
    totalObjectChanges: trace.objectChanges.length,
    createdCapabilitiesNotEvaluated: capabilities.filter((c) => c.changeType === "created").length,
    deletedCapabilitiesNotEvaluated: capabilities.filter((c) => c.changeType === "deleted").length,
    capabilityMovesWithUnresolvableOwner: capabilities.filter(
      (c) => c.changeType === "mutated" && !c.recipient && c.sender !== trace.sender
    ).length,
    unrecordedOwnerKinds: capabilities.filter((c) => outputOwnerOf(c).kind === "unrecorded").length,
    note:
      'capabilities are recognised by objectType only; object changes whose type the RPC reported as ' +
      `"unknown" (${unresolvedObjectTypes}/${trace.objectChanges.length} here) cannot be classified, ` +
      "and a new owner that is not an address owner is reported as recipient: null",
  };
}

export const capabilityTransfer: InvariantChecker = {
  name: "capability-transfer",
  description:
    "Flags capability objects (TreasuryCap, AdminCap, UpgradeCap, etc.) that a transaction moves out of " +
    "the sender's address ownership — to another address or into a non-address owner",
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const coverage = coverageOf(trace);

    for (const change of trace.objectChanges) {
      // Untyped object changes cannot be classified as capabilities at all.
      if (!typeKnown(change)) continue;
      if (!isCapability(change.objectType)) continue;

      // A capability minted by this transaction did not change hands — it appeared here.
      if (change.changeType === "created") continue;
      // A burned/destroyed capability has no new owner.
      if (change.changeType === "deleted") continue;
      if (change.changeType !== "mutated") continue;

      const owner = outputOwnerOf(change);
      const baseEvidence = {
        objectId: change.objectId,
        objectType: change.objectType,
        changeType: change.changeType,
        recipientKind: owner.kind,
        sender: trace.sender,
        classification: coverage,
      };

      if (change.recipient) {
        if (change.recipient === trace.sender) continue;

        violations.push({
          type: "CAPABILITY_TRANSFER",
          severity: "high",
          message: `${shortCapName(change.objectType)} transferred to ${change.recipient.slice(0, 12)}…`,
          evidence: {
            ...baseEvidence,
            recipient: change.recipient,
            previousOwner: change.sender ?? null,
          },
        });
        continue;
      }

      // The capability is no longer owned by an address: wrapped in another object, shared, or
      // frozen. Still the sender losing it, as long as the sender demonstrably held it at input.
      // When an object owns it the chain names that object, so the finding names it too.
      if (change.sender && change.sender === trace.sender) {
        const ownerNames = owner.objectId
          ? `${owner.kind} ${owner.objectId.slice(0, 12)}…`
          : owner.kind;

        violations.push({
          type: "CAPABILITY_TRANSFER",
          severity: "high",
          message:
            `${shortCapName(change.objectType)} left the sender's address ownership into a ` +
            `non-address owner (${ownerNames})`,
          evidence: {
            ...baseEvidence,
            recipient: null,
            ...(owner.objectId ? { recipientObject: owner.objectId } : {}),
            previousOwner: change.sender,
            note:
              owner.kind === "unrecorded"
                ? UNRECORDED_NOTE
                : "recipient is null because the new owner is not an address owner",
          },
        });
      }
    }

    return violations;
  },
};
