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

export type OwnerKind = "address" | "object" | "immutable" | "shared" | "unresolved";

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
    default:
      return undefined;
  }
}

/**
 * The address behind an owner, when an address is what owns it.
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
  return undefined;
}

/**
 * Output owner of one object change, as far as this trace can say. `recipient` is only populated
 * for an address owner, so it short-circuits the classification; otherwise the kind is recovered
 * from the raw response while it is still attached.
 */
export function outputOwnerKind(
  trace: SuiTransactionTrace,
  change: ObjectChange
): OwnerKind {
  if (change.recipient) return "address";

  const raw: any = trace.raw;
  const changed: any[] | undefined = raw?.effects?.changedObjects;
  if (!Array.isArray(changed)) return "unresolved";

  const hit = changed.find((o) => o?.objectId === change.objectId);
  return ownerKindOf(hit?.outputOwner) ?? "unresolved";
}
