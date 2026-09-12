module chase_test::gift;

public struct Prize has key, store {
    id: UID,
    value: u64,
}

public fun give(prize: Prize, recipient: address) {
    transfer::transfer(prize, recipient);
}

entry fun mint_for_self(ctx: &mut TxContext) {
    let prize = Prize {
        id: object::new(ctx),
        value: 42,
    };
    transfer::transfer(prize, ctx.sender());
}
