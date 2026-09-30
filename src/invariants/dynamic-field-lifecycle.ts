import { InvariantChecker, SuiTransactionTrace, Violation } from "../lib/types.js";
import { moveTypePackage, normalizeAddress } from "../lib/target.js";
import { outputOwnerOf } from "../lib/owner.js";

const FRAMEWORK = normalizeAddress("0x2")!;
const FIELD_INFIX = "::dynamic_field::Field<";

/**
 * Dynamic fields are separate objects: a `Field<K, V>` sits beside its parent and is addressed on
 * its own. Touching one is routine — 3,807 of 6,502 sampled mainnet transactions involve at least
 * one, and 14,497 of 14,816 field object-changes are plain mutations, so a "field was written"
 * rule is a traffic counter, not a signal.
 *
 * A field being *created* or *deleted* is the narrow end: 128 and 58 transactions respectively.
 * Both are declared `corroborates: false`, because that 2%-of-traffic shape must not raise another
 * finding's priority: measured on this corpus, letting it corroborate moved two already-P1 oracle
 * transactions' reentrancy findings from P3 to P2 on the strength of a field appearing.
 * Which field (the key value) is not in the trace; the field's type is, and since the owner is
 * recorded at fetch time, an object-owned field names the parent it belongs to.
 */
export const dynamicFieldLifecycle: InvariantChecker = {
  name: "dynamic-field-lifecycle",
  description:
    "Reports dynamic-field objects created or destroyed by the transaction (not mutated: mutation " +
    "covers 58.6% of mainnet traffic and says nothing), naming the parent object when the trace recorded one",
  // reports, does not corroborate — see the measured reason below
  emits: [
    { type: "DYNAMIC_FIELD_CREATED", severity: "low", corroborates: false },
    { type: "DYNAMIC_FIELD_DELETED", severity: "low", corroborates: false },
  ],
  check(trace: SuiTransactionTrace): Violation[] {
    const violations: Violation[] = [];

    for (const change of trace.objectChanges) {
      const type = change.objectType ?? "";
      if (!type.includes(FIELD_INFIX)) continue;
      if (moveTypePackage(type) !== FRAMEWORK) continue;
      if (change.changeType !== "created" && change.changeType !== "deleted") continue;

      const { keyType, valueType } = parseFieldTypes(type);
      const owner = outputOwnerOf(change);
      const valuePackage = moveTypePackage(valueType ?? "");
      const parentSpoke =
        !!valuePackage &&
        (trace.events ?? []).some(
          (e) => moveTypePackage(e.type) === valuePackage || normalizeAddress(e.packageId) === valuePackage
        );

      const verb = change.changeType === "created" ? "created" : "destroyed";
      violations.push({
        type: change.changeType === "created" ? "DYNAMIC_FIELD_CREATED" : "DYNAMIC_FIELD_DELETED",
        severity: "low",
        message:
          `dynamic field <${keyType ?? "?"}, ${short(valueType ?? "?")}> ${verb}` +
          (owner.objectId ? ` on ${owner.objectId.slice(0, 12)}…` : ` (${owner.kind}, parent not recorded)`),
        evidence: {
          objectId: change.objectId,
          fieldType: type,
          keyType,
          valueType,
          changeType: change.changeType,
          recipientKind: owner.kind,
          ...(owner.objectId ? { parentObject: owner.objectId } : {}),
          valuePackageSpoke: parentSpoke,
          eventsInTrace: (trace.events ?? []).length,
          note:
            "a field appearing or disappearing is a state change, not a vulnerability: protocols " +
            "add and remove fields routinely. The key value and therefore which field is not in " +
            "this trace. valuePackageSpoke says whether the package that owns the stored type " +
            "emitted an event in this transaction at all.",
        },
      });
    }

    return violations;
  },
};

/** `Field<u64,0x…::pool::Pool<A,B>>` -> key `u64`, value the rest, split at the top level. */
function parseFieldTypes(type: string): { keyType?: string; valueType?: string } {
  const start = type.indexOf(FIELD_INFIX);
  if (start === -1) return {};
  const head = type.slice(start + FIELD_INFIX.length);
  if (!head.endsWith(">")) return {};
  const inner = head.slice(0, -1);

  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      return { keyType: inner.slice(0, i).trim(), valueType: inner.slice(i + 1).trim() };
    }
  }
  return { keyType: inner.trim() };
}

function short(t: string): string {
  const parts = t.split("::");
  return parts.length >= 2 ? `${parts[parts.length - 2]}::${parts[parts.length - 1]}` : t;
}
