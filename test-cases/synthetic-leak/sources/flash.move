module chase_test::flash;

public struct Pool has key {
    id: UID,
    reserve: u64,
}

entry fun create(ctx: &mut TxContext) {
    let pool = Pool {
        id: object::new(ctx),
        reserve: 1_000_000,
    };
    transfer::share_object(pool);
}

// Matches BORROW_KEYWORDS
public fun flash_borrow(pool: &mut Pool, amount: u64) {
    pool.reserve = pool.reserve + amount;
}

// Matches ACTION_KEYWORDS
public fun swap(pool: &mut Pool, amount: u64) {
    pool.reserve = pool.reserve + amount;
}

// Matches REPAY_KEYWORDS
public fun flash_repay(pool: &mut Pool, amount: u64) {
    pool.reserve = pool.reserve - amount;
}
