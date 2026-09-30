import { ObjectChange, SuiTransactionTrace } from "./types.js";

/**
 * The owner shapes the gRPC SDK can produce. `mapOwner` in @mysten/sui returns exactly these and
 * throws on anything else, so a kind outside this list never reaches a detector — it fails the
 * fetch. Named literally because the offline corpus cannot show the difference: both ownership
 * rules used to switch on `Parent` and `DerivedAddress`, which appear nowhere in the SDK, and fell
 * through on `ConsensusAddressOwner`, which does.
 */
export const SDK_OWNER_KINDS = [
  "Immutable",
  "AddressOwner",
  "ObjectOwner",
  "Shared",
  "ConsensusAddressOwner",
] as const;

export type OwnerKind =
  | "address"
  | "consensus-address"
  | "object"
  | "immutable"
  | "shared"
  | "unresolved";

export function ownerKindOf(owner: any): OwnerKind | undefined {
  switch (owner?.$kind) {
    case "AddressOwner":
      return "address";
    case "ObjectOwner":
      return "object";
    case "Immutable":
      return "immutable";
    case "Shared":
      return "shared";
    case "ConsensusAddressOwner":
      return "consensus-address";
    default:
      return undefined;
  }
}

/**
 * The address behind an owner, when an address is what owns it.
 *
 * A consensus-address-owned object *is* owned by an address — the SDK nests it one level down at
 * `.ConsensusAddressOwner.owner`. Reading nothing there made such an object look like it had no
 * address owner any more, which is precisely the condition the ownership rules branch on.
 *
 * `ObjectOwner` deliberately returns nothing: its value is an object id, and putting that in a
 * field named `recipient` would make a wrapped object read as a transfer to an address.
 */
export function ownerAddress(owner: any): string | undefined {
  if (!owner) return undefined;
  if (typeof owner === "string") return owner;
  if (owner.$kind === "AddressOwner" && typeof owner.AddressOwner === "string") {
    return owner.AddressOwner;
  }
  if (
    owner.$kind === "ConsensusAddressOwner" &&
    typeof owner.ConsensusAddressOwner?.owner === "string"
  ) {
    return owner.ConsensusAddressOwner.owner;
  }
  return undefined;
}

/**
 * Output owner of one object change, as far as this trace can say. The owner shape is read first
 * so a consensus-address owner stays distinguishable from a plain one; `recipient` is the fallback
 * proof that *an* address owns it, not a classification.
 */
export function outputOwnerKind(
  trace: SuiTransactionTrace,
  change: ObjectChange
): OwnerKind {
  const raw: any = trace.raw;
  const changed: any[] | undefined = raw?.effects?.changedObjects;
  if (Array.isArray(changed)) {
    const hit = changed.find((o) => o?.objectId === change.objectId);
    const kind = ownerKindOf(hit?.outputOwner);
    if (kind) return kind;
  }

  // No owner shape to read: an address in `recipient` still proves *an* address owns it.
  if (change.recipient) return "address";
  return "unresolved";
}
