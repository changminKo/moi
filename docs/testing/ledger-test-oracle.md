# Ledger contract oracle

This is the independent acceptance oracle for the Plan 1 ledger. The contract
runs against PostgreSQL 17, reads the persisted rows with plain SQL, and performs
its arithmetic with a test-local exact scaled-integer implementation. The oracle
does not call the production fee, execution, reservation, decimal, or accounting
helpers. Those helpers are used only by the Plan 1 scenario driver that writes
the ledger.

The distinction matters: if the writer and oracle calculated an expected value
with the same helper, one defect could appear on both sides and produce a false
pass. The golden values below are hand-derived literals, and the test checks the
rows after reserve, after partial fill, and after cancel. A driver that does
nothing therefore fails at the first partial-fill snapshot even though a
before/after conservation equation alone could balance trivially.

## Inputs and sign convention

For snapshots `B` (before) and `A` (after), `Δx = A.x - B.x`. Only fills present
in `A` and not in `B` belong to the interval. A positive cash outflow removes
money from the wallet; a positive position inflow adds quantity.

For a fill with price `p`, quantity `q`, and fee `f`:

- BUY cash outflow: `p × q + f`
- SELL cash outflow: `f - p × q` (normally negative because a sell adds cash)
- BUY position inflow: `+q`
- SELL position inflow: `-q`

All terms are parsed from PostgreSQL `numeric::text`. Values are aligned to a
common decimal scale and evaluated as integers, so no binary floating-point or
rounding tolerance appears in the oracle.

## Equations

Each residual below must be exactly zero.

### E1 — bucket composition

For every wallet and position in both snapshots:

```text
wallet.total - wallet.available - wallet.reserved = 0
position.total - position.available - position.reserved = 0
```

This prevents the interval equations from building on an already-corrupt row.

### E2 — cash conservation

For each currency:

```text
Δwallet.total + Σ cash_outflow(new fills in that currency) = 0
```

A reservation or cancellation moves money between `available` and `reserved`
but does not change `total`. Only execution changes total cash.

### E3 — cash reservation backing

For each currency in the after snapshot:

```text
wallet.reserved - Σ unreleased CASH reservation.amount = 0
```

This catches reserved cash that no live reservation can release, and live
reservations that are not backed by the wallet.

### E4 — position conservation

For each market and symbol:

```text
Δposition.total - Σ position_inflow(new fills for the symbol) = 0
```

### E5 — position reservation backing

For each market and symbol in the after snapshot:

```text
position.reserved - Σ unreleased POSITION reservation.amount = 0
```

### E6 — order/fill agreement

For every order in the after snapshot:

```text
order.filled_quantity - Σ fill.quantity for that order = 0
```

The aggregate verdict reports `delta = Σ |residual|`. It is balanced only when
every residual is zero; malformed sides or decimal text fail loudly instead of
being treated as balanced.

## Golden KRW example

BUY 10 shares at a KRW 70,000 limit from a KRW 1,000,000 wallet, then fill 4
shares and cancel the remaining 6. Commission is 0.015%, rounded down to whole
KRW.

```text
initial notional       = 70,000 × 10       = 700,000
initial fee            = 700,000 × 0.00015 = 105
initial reservation    = 700,000 + 105     = 700,105

fill notional          = 70,000 × 4        = 280,000
fill fee               = 280,000 × 0.00015 = 42
fill cash outflow      = 280,000 + 42      = 280,042

remaining notional     = 70,000 × 6        = 420,000
remaining fee          = 420,000 × 0.00015 = 63
remaining reservation  = 420,000 + 63      = 420,063
```

| Leg | Wallet total | Available | Reserved | Position total | Order state / filled |
|---|---:|---:|---:|---:|---|
| Before | 1,000,000 | 1,000,000 | 0 | 0 | absent |
| Reserve | 1,000,000 | 299,895 | 700,105 | 0 | OPEN / 0 |
| Partial fill | 719,958 | 299,895 | 420,063 | 4 | PARTIALLY_FILLED / 4 |
| Cancel | 719,958 | 719,958 | 0 | 4 | CANCELLED / 4 |

The fill row is `(price 70000, quantity 4, fee 42)`. The reservation row moves
from amount `700105` to `420063`, then becomes released. The fill and position
remain after cancellation.

## Golden USD example

BUY 10 shares at a USD 185.50 limit from a USD 10,000.00 wallet, then fill 4
shares and cancel the remaining 6. Commission is 0.25%, rounded half-up to two
decimal places.

```text
initial notional       = 185.50 × 10       = 1,855.00
initial raw fee        = 1,855.00 × 0.0025 = 4.6375
initial fee            = round_half_up(4.6375, 2) = 4.64
initial reservation    = 1,855.00 + 4.64   = 1,859.64

fill notional          = 185.50 × 4        = 742.00
fill raw fee           = 742.00 × 0.0025   = 1.855
fill fee               = round_half_up(1.855, 2) = 1.86
fill cash outflow      = 742.00 + 1.86     = 743.86

remaining notional     = 185.50 × 6        = 1,113.00
remaining raw fee      = 1,113.00 × 0.0025 = 2.7825
remaining fee          = round_half_up(2.7825, 2) = 2.78
remaining reservation  = 1,113.00 + 2.78   = 1,115.78
```

| Leg | Wallet total | Available | Reserved | Position total | Order state / filled |
|---|---:|---:|---:|---:|---|
| Before | 10,000.00 | 10,000.00 | 0 | 0 | absent |
| Reserve | 10,000.00 | 8,140.36 | 1,859.64 | 0 | OPEN / 0 |
| Partial fill | 9,256.14 | 8,140.36 | 1,115.78 | 4 | PARTIALLY_FILLED / 4 |
| Cancel | 9,256.14 | 9,256.14 | 0 | 4 | CANCELLED / 4 |

The fill row is `(price 185.50, quantity 4, fee 1.86)`. The reservation row
moves from amount `1859.64` to `1115.78`, then becomes released.

## Reuse contract

A later API or engine provides the same three driver operations — `reserve`,
`partialFill`, and `cancel` — and runs the scenario and assertions unchanged.
The acceptance boundary is persisted behavior, not which application service
or engine component produced it. Each test owns a fresh anonymous session, and
cleanup cascades its ledger rows before the next scenario; audit rows are
truncated separately because audit history intentionally has no session foreign
key.
