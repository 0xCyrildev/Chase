# Synthetic Leak Package

A minimal Sui Move package with three modules, each demonstrating a
bug class that Chase detects. Used as positive controls for the invariant
suite.

## Modules

### `leak` — mutable-access

    public fun leak_mut(vault: &mut Vault): &mut Inner {
        abort 0
    }

A `public` function returning `&mut Inner`. This is the OpenZeppelin
visibility bug class: an internal helper mistakenly exposed as world-callable.
The `abort 0` body is a stub; the signature alone is what Chase reads.

Expected: `MUTABLE_REFERENCE_RETURNED` (high).

### `oracle` — oracle-pattern

Two public functions, `update_price` and `swap`. When both are called in the
same PTB (via `sui client ptb`), Chase sees an oracle update followed by a
DeFi action.

Expected: `ORACLE_MANIPULATION_SUSPECTED` (high).

### `gift` — ownership-anomaly

`give(prize, recipient)` transfers an owned object to an arbitrary address.
Called with a recipient that has no other role in the transaction.

Expected: `UNEXPECTED_TRANSFER` (medium).

## Reproducing

    sui client switch --env testnet
    sui move build
    sui client publish --gas-budget 100000000

Copy the package ID from the publish output. Then for each module:

### mutable-access

    sui client call --package <PKG> --module leak --function create \
      --gas-budget 10000000
    # copy the Vault object ID from the output

    sui client call --package <PKG> --module leak --function leak_mut \
      --args <VAULT_ID> --gas-budget 10000000
    # this aborts by design; copy the digest

    SUI_NETWORK=testnet npm run analyze -- <DIGEST> --debug

### oracle-pattern

    sui client call --package <PKG> --module oracle --function init_price \
      --gas-budget 10000000
    # copy PriceState ID and Pool ID from the output

    sui client ptb \
      --move-call <PKG>::oracle::update_price @<PRICE_STATE_ID> 999 \
      --move-call <PKG>::oracle::swap @<POOL_ID> 1 \
      --gas-budget 10000000
    # copy the digest

    SUI_NETWORK=testnet npm run analyze -- <DIGEST> --debug

### ownership-anomaly

    sui client call --package <PKG> --module gift --function mint_for_self \
      --gas-budget 10000000
    # copy the Prize object ID from the output

    sui client call --package <PKG> --module gift --function give \
      --args <PRIZE_ID> 0x000000000000000000000000000000000000000000000000000000000000beef \
      --gas-budget 10000000
    # copy the digest

    SUI_NETWORK=testnet npm run analyze -- <DIGEST> --debug

## Reference deployment

Original testnet deployment (2026-09-12, epoch 1220):

- Package: `0x9f85d10dad043859531c8ddf01e9978d20816bbc70abf49456f7963d005e994e`
- Modules: `gift`, `leak`, `oracle`

Positive control digests:

- `9gwFpqxGmnfUyu8ciiEHHKHmWw42vMJddD6PpUuGLkKg` — leak (`MUTABLE_REFERENCE_RETURNED`)
- `7Y3T5H7oXRhG1vjhnAERiseYW6tY4XndAfHSrrbVwKT2` — oracle (`ORACLE_MANIPULATION_SUSPECTED`)
- `EpcqsX3RHDwpE2YAqHcfcKtDExjTBkz5FczQUk9PB4gp` — gift (`UNEXPECTED_TRANSFER`)

Testnet is wiped periodically. When the digests stop resolving, re-publish
the package and update `test-cases/known-txs.json` with the new digests.
