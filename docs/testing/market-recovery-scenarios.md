# Market recovery scenarios

`lossy-recovery.json` is the canonical Plan 2 loss-of-feed scenario. It is
seeded with `220826` so generated event permutations and replay after a
simulated restart have a stable input.

The scenario deliberately does not reconstruct the trade that crossed while
the transport was closed. A recovery REST price and book establish a new
baseline in epoch 2; a frame from epoch 1 is rejected, and only a current
epoch recovery trigger may fill the resting stop. The fault suite records the
pricing source, epoch, fencing token, and market-data version for each fill.

The assertions are safety properties: no historical fill, at most one
recovery fill, a balanced ledger, one incident chain, stale-frame rejection,
and no rearming of terminal orders. The same action set is exercised in
permuted order and after rebuilding the engine to model a process restart;
the canonical outcome must remain identical.

Run it without network access with:

```sh
pnpm --filter @moi/paper-api test -- paper-engine.fault.integration.test.ts --reporter=verbose
```
