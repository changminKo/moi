# Paper API quote contract

A quote has **one shape**. The same object is the body of

```
GET /api/v1/markets/{market}/symbols/{symbol}/quote
```

and the `payload` of a stream `quote` frame. `projectQuote` in
`apps/paper-api/src/market-data/quote-projection.ts` is the only builder, and
the table below is kept equal to `QUOTE_PROJECTION_FIELDS` by test
(`quote-projection.test.ts`).

This document exists because nothing pinned the frame's payload before, and
three layers each invented a different shape — see spec §16.36.

## Fields

| Field | Type | Always present | Notes |
| --- | --- | :---: | --- |
| `market` | `"KR" \| "US"` | yes | |
| `symbol` | string | yes | |
| `price` | decimal string, or `null` | yes | Last trade, else best ask, else best bid (§16.33). `null` when the symbol's slot is empty — never invented. |
| `asOf` | ISO-8601 UTC string | yes | The instant of the **projection**, not of the market event. |
| `health` | `"HEALTHY" \| "DEGRADED" \| "RECOVERING"` | yes | The market's health at projection time. |
| `recoveryEpoch` | decimal string | yes | Stringified; never a JSON number. |
| `marketDataVersion` | decimal string | yes | Stringified; never a JSON number. |
| `currency` | `"KRW" \| "USD"` | **no** | Book-derived. |
| `bids` | array of levels, best first | **no** | Book-derived. |
| `asks` | array of levels, best first | **no** | Book-derived. |

A level is exactly `{ "price": decimal string, "volume": decimal string }`.

## Rules

1. **Money and quantities are decimal strings, never JSON numbers.** This
   holds for `price` and for a level's `price` and `volume`.
2. **The quantity field is `volume`.** The same word the ledger column
   `book_level_volume`, `OrderBookLevel` in `@moi/trading-core`, and the engine
   use. It is never `size`.
3. **`currency`, `bids` and `asks` are omitted, not emptied,** when the
   symbol's slot holds no book. A consumer merging a frame onto a snapshot must
   treat an absent side as "unchanged", not as "now empty" — otherwise a trade
   that arrives before the first book blanks the depth on screen.
4. **A `quote` frame need not restate every field.** It carries what the
   projection knows at that moment; a consumer merges it onto the quote it is
   already showing rather than replacing it. `applyQuoteFrame` in
   `apps/web/src/lib/quote-frame.ts` is the browser's side of this.
5. **`recoveryEpoch` and `marketDataVersion` also appear on the frame
   envelope,** beside `type`, `market` and `symbol`. The envelope's values and
   the payload's are the same; a consumer may read either.

## Example

A `US:AAPL` frame with a two-sided book:

```json
{
  "type": "quote",
  "market": "US",
  "symbol": "AAPL",
  "recoveryEpoch": "17",
  "marketDataVersion": "87850",
  "payload": {
    "market": "US",
    "symbol": "AAPL",
    "price": "316.44",
    "asOf": "2026-09-01T14:02:03.000Z",
    "health": "HEALTHY",
    "recoveryEpoch": "17",
    "marketDataVersion": "87850",
    "currency": "USD",
    "bids": [{ "price": "316.44", "volume": "80" }],
    "asks": [{ "price": "316.65", "volume": "40" }]
  }
}
```

The REST answer for the same symbol at the same moment is that `payload`
object exactly.
