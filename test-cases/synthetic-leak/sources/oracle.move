module chase_test::oracle;

public struct PriceState has key {
    id: UID,
    price: u64,
}

public struct Pool has key {
    id: UID,
    reserve: u64,
}

entry fun init_price(ctx: &mut TxContext) {
    let state = PriceState {
        id: object::new(ctx),
        price: 100,
    };
    transfer::share_object(state);

    let pool = Pool {
        id: object::new(ctx),
        reserve: 1_000_000,
    };
    transfer::share_object(pool);
}

// Name-matches the oracle-pattern keyword list
public fun update_price(state: &mut PriceState, new_price: u64) {
    state.price = new_price;
}

// Name-matches the DeFi action keyword list
public fun swap(pool: &mut Pool, amount: u64) {
    pool.reserve = pool.reserve + amount;
}
