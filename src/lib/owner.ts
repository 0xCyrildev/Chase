import { ObjectChange, OwnerKind } from "./types.js";

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

export function ownerKindOf(owner: any): Exclude<OwnerKind, "unrecorded"> | undefined {
  switch (owner?.$kind) {
    case "AddressOwner":
      return "address";
    case "ConsensusAddressOwner":
      return "consensus-address";
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

/** The object behind an owner, when another object owns it. */
export function ownerObjectId(owner: any): string | undefined {
  if (owner?.$kind === "ObjectOwner" && typeof owner.ObjectOwner === "string") {
    return owner.ObjectOwner;
  }
  return undefined;
}

/**
 * Who owns this object now, according to the record the fetch left on the change.
 *
 * Nothing here reads a raw response: a rule that can only be answered on a first, uncached fetch
 * is a rule that silently stops applying the moment a digest is in the cache, which is most
 * digests most of the time. `unrecorded` is what an older cached trace can honestly say.
 */
export function outputOwnerOf(change: ObjectChange): { kind: OwnerKind; objectId?: string } {
  if (change.outputOwnerKind) {
    return { kind: change.outputOwnerKind, objectId: change.outputOwnerId };
  }

  // Traces normalised before owners were recorded. An address in `recipient` still proves that an
  // address owns it; anything beyond that was never looked at.
  if (change.recipient) return { kind: "address" };
  return { kind: "unrecorded" };
}

/** A finding must say so when the owner was never recorded, rather than leaving it implicit. */
export const UNRECORDED_NOTE =
  "owner kind was not recorded for this cached trace — re-analyze with --no-cache to resolve it";
