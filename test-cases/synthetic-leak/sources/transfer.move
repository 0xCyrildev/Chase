module chase_test::gift;

public struct Prize has key, store {
    id: UID,
    value: u64,
}

// Takes an owned Prize and transfers it to an arbitrary recipient.
// When called in a PTB where the recipient has no other role,
// ownership-anomaly should fire UNEXPECTED_TRANSFER.
public fun give(prize: Prize, recipient: address) {
    transfer::transfer(prize, recipient);
}

entry fun mint(ctx: &mut TxContext): Prize {
    Prize {
        id: object::new(ctx),
        value: 42,
    }
}
