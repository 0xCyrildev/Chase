import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";
import { moveTypePackage, normalizeAddress } from "../lib/target.js";
import { outputOwnerOf } from "../lib/owner.js";

const FRAMEWORK_PACKAGES = new Set(
  ["0x1", "0x2", "0x3"].map((a) => normalizeAddress(a)!)
);
const FIELD_INFIX = "::dynamic_field::Field<";

/**
 * A stored object changed hands or contents, and the package that owns its type said nothing about
 * it in this transaction.
 *
 * The narrow end is deliberate. "The transaction emitted no events at all" sounds like the anomaly,
 * and is not: 2,545 of 6,502 sampled mainnet transactions (39%) emit nothing, so silence is the
 * near-majority normal rather than a deviation. A rule built on it fires on 9.04% of traffic and on
 * six of this repo's own nine synthetic fixtures — the test package simply does not emit — which
 * would make it a tier-inflation machine rather than a detector. What is left after narrowing is
 * 38 changes: an object the sender demonstrably held, in a package that said nothing, while other
 * packages in the same transaction did.
 *
 * The population is dominated by capability-*shaped* types on order books (`TradeCap`,
 * `PriceFeederCap`, `AuthorityCap`, `OrderCap`). That is a description of what fires, not a claim
 * about what they are: `capability-transfer` matches none of those names.
 */
export const silentObjectChange: InvariantChecker = {
  name: "silent-object-change",
  description:
    "Reports a sender-held object that was mutated or destroyed while no event in the transaction came " +
    "from the package that owns its type (not that the transaction was silent, since 39% of traffic is)",
  emits: [{ type: "UNANNOUNCED_OBJECT_CHANGE", severity: "low", corroborates: false }],
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];
    const spoke = announcedPackages(trace);

    for (const change of silentCandidates(trace)) {
      if (change.sender !== trace.sender) continue;
      const pkg = moveTypePackage(change.objectType);
      if (!pkg || spoke.has(pkg)) continue;

      const owner = outputOwnerOf(change);
      const module = change.objectType.split("::")[1] ?? "?";
      violations.push({
        type: "UNANNOUNCED_OBJECT_CHANGE",
        severity: "low",
        message:
          `${short(change.objectType)} ${change.changeType === "deleted" ? "destroyed" : "mutated"} with no ` +
          `event from ${module} (the sender held it; ${owner.kind === "unrecorded" ? "owner not recorded" : `now ${owner.kind}`})`,
        evidence: {
          objectId: change.objectId,
          objectType: change.objectType,
          changeType: change.changeType,
          changedPackage: pkg,
          recipientKind: owner.kind,
          ...(owner.objectId ? { parentObject: owner.objectId } : {}),
          eventsInTx: (trace.events ?? []).length,
          eventPackages: [...new Set((trace.events ?? []).map((e) => e.packageId))].slice(0, 6),
          eventPackageCount: new Set((trace.events ?? []).map((e) => e.packageId)).size,
          note:
            "an absence, not a proof: silent updates are a design choice, and this says only that no " +
            "event in this transaction came from the package that owns the object's type. Read the " +
            "function that wrote it before treating it as anything.",
        },
      });
    }

    return violations;
  },
};

/** Packages that emitted something here, from both positions Sui reports them in. */
function announcedPackages(trace: SuiTransactionTrace): Set<string> {
  const out = new Set<string>();
  for (const e of trace.events ?? []) {
    const fromType = moveTypePackage(e.type);
    if (fromType) out.add(fromType);
    const fromId = normalizeAddress(e.packageId ?? "");
    if (fromId) out.add(fromId);
  }
  return out;
}

/**
 * Typed, non-framework, non-dynamic-field objects this transaction mutated or destroyed. The wide
 * shape, counted for reporting: on this corpus 4,472 transactions contain at least one, and 602 of
 * them emitted no event at all. That is stated as an observation because a clean report on a silent
 * transaction should not read as a survey of an announceful one.
 */
export function silentCandidates(trace: SuiTransactionTrace) {
  return (trace.objectChanges ?? []).filter((c) => {
    const type = c.objectType ?? "";
    if (!type || type === "unknown") return false;
    if (type.includes(FIELD_INFIX)) return false;
    const pkg = moveTypePackage(type);
    if (!pkg || FRAMEWORK_PACKAGES.has(pkg)) return false;
    return c.changeType === "mutated" || c.changeType === "deleted";
  });
}

export function objectChangesWithNoEventInTx(trace: SuiTransactionTrace): number {
  if ((trace.events ?? []).length > 0) return 0;
  return silentCandidates(trace).length;
}

function short(t: string): string {
  const parts = t.split("::");
  return parts.length >= 2 ? `${parts[parts.length - 2]}::${parts[parts.length - 1]}` : t;
}
