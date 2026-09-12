module chase_test::leak;

public struct Vault has key {
    id: UID,
    balance: u64,
}

public struct Inner has key, store {
    id: UID,
    secret: u64,
}

// VULNERABLE: returns &mut to an internal object from a public function.
// This is the exact pattern Chase's mutable-access invariant targets.
public fun leak_mut(vault: &mut Vault): &mut Inner {
    // In a real bug, this would borrow from a dynamic field or a wrapped object.
    // For the synthetic test, we just abort so we don't actually need to
    // construct an Inner. The signature alone is what Chase detects.
    abort 0
}

// Control: a public function that does NOT return a mutable reference.
public fun safe_read(vault: &Vault): u64 {
    vault.balance
}

// Entry to create a Vault so we have something to pass in.
entry fun create(ctx: &mut TxContext) {
    let vault = Vault {
        id: object::new(ctx),
        balance: 1000,
    };
    transfer::share_object(vault);
}
