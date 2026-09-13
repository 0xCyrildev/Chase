module chase_test::cap;

use sui::coin::{Self, TreasuryCap};

public struct CAP has drop {}

fun init(witness: CAP, ctx: &mut TxContext) {
    let (treasury, metadata) = coin::create_currency(
        witness,
        9,
        b"CHASECAP",
        b"Chase Test Cap",
        b"",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury, ctx.sender());
}

// Transfers a TreasuryCap to an arbitrary recipient.
// Fires CAPABILITY_TRANSFER when the recipient is not the sender.
entry fun give_cap<T>(treasury: TreasuryCap<T>, recipient: address) {
    transfer::public_transfer(treasury, recipient);
}
