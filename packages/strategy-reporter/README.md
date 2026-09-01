# @moi/strategy-reporter

The strategy runner's Discord voice — the `Reporter` box in §3 of
`docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md`.

It is a standalone package rather than a module inside `apps/strategy-runner`
because the runner's skeleton is being built in parallel; the runner composes
it, and nothing here knows what a strategy, an order or a ledger is.

## What the runner calls

```ts
import { createReporter, readReporterConfig, sessionSwapped } from '@moi/strategy-reporter';

const config = readReporterConfig(process.env);
if (!config.ok) throw new ConfigError(config.problem); // fail closed on a misconfigured channel

const reporter = createReporter({
  webhookUrl: config.webhookUrl,          // '' → a silent no-op, like notify.sh
  source: hostname(),
  // Read at send time: the cookie and the CSRF token rotate.
  secrets: () => [config.webhookUrl, ...sessionStore.secretValues()],
  onDiagnostic: (line) => log.warn({ msg: line }),
});

reporter.report(sessionSwapped({ previousSessionId, sessionId, reason }));
await reporter.close();  // in the shutdown path
```

`report` is synchronous, returns nothing, and cannot throw: reporting is never
on the critical path of a decision.

Adding an event is one helper beside `sessionSwapped` in `events.ts`. The event
taxonomy is deliberately not enumerated — §4.3 gives the one concrete case and
§7 adds more once the kill-switch barrier exists.

## The three properties

**Masking is enforced, not remembered.** `ReportEvent` carries strings and
nothing else, and every string passes through `maskOutbound` at the single
point where the payload is rendered. Two layers: pattern rules (Discord webhook
URLs, URL credentials, `Bearer`, `moi_session=`, `X-CSRF-Token`, `Set-Cookie`,
`Idempotency-Key`, `*KEY|TOKEN|SECRET|PASSWORD*=` assignments — the rules
`infra/oracle/notify.sh` applies on the host, plus the four §7.4 adds) and
exact-value substitution for the secrets the runner holds. Then the finished
JSON is checked with `containsSecret`, and a survivor is **dropped rather than
posted**. Delivery fails open; a secret fails closed.

**Fail-open delivery.** A Discord outage, a revoked webhook or a missing
variable costs a counter on `stats()`, never a trading decision and never a
crash — the position `infra/oracle/notify.sh` takes for deploys.

**A bounded budget.** Aggregation collapses repeats of a key inside a 60 s
window onto one message carrying `+N suppressed`; a 5-token bucket refilling
one token per 12 s paces the rest; the last 2 tokens are reserved for `warn`
and `fail`, so routine traffic can never starve a kill-switch report. Routine
messages past the reserve are dropped and counted, alerts are queued until a
token exists, and both counts ride on the next posted embed.

## Channel separation

The runner reads `DISCORD_WEBHOOK_TRADE_URL` and never
`DISCORD_WEBHOOK_URL`. `readReporterConfig` refuses the operational webhook
handed in under the trade name, so trading noise cannot bury an incident alert.

## Tests

`src/testing/fake-discord-server.ts` is a loopback `node:http` stand-in, the
shape `packages/market-data/src/testing/fake-toss` uses. AGENTS.md hard rule 1
applies to Discord too: no test reaches the real service, and
`package-surface.test.ts` asserts that every webhook a posting test is handed
is the fake.
