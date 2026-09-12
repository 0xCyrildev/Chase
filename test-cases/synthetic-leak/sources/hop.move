module chase_test::hop;

public struct Counter has key {
    id: UID,
    value: u64,
}

entry fun create(ctx: &mut TxContext) {
    let c = Counter {
        id: object::new(ctx),
        value: 0,
    };
    transfer::share_object(c);
}

public fun first(c: &mut Counter) {
    c.value = c.value + 1;
}

public fun second(c: &mut Counter) {
    c.value = c.value + 10;
}
