# `infra/bot` — the strategy runner's operator configuration

Mounted read-only at `/etc/moi-bot` in the `bot` service;
`BOT_CONFIG_PATH` points at `/etc/moi-bot/runner.json`.

```bash
cp infra/bot/runner.example.json infra/bot/runner.json
$EDITOR infra/bot/runner.json
# local compose stack:
docker compose -f infra/compose.yaml --profile bot up -d bot
# the Oracle reference host: put COMPOSE_PROFILES=bot in /etc/moi/moi.env and
# run infra/oracle/deploy.sh — see docs/operations/deployment.md.
```

`runner.example.json` is loaded by a test (`apps/strategy-runner/src/config.test.ts`),
so it is always a file the runner accepts.

`runner.json` is **not committed** (`.gitignore`). Risk limits and the symbol
allow-list are a decision the operator makes for one deployment, and a
committed default is a default someone eventually runs by accident. The runner
has no fallback for any of them: a missing or malformed file is a refusal to
start, not a degraded run (`apps/strategy-runner/src/config.ts`).

The example is a starting shape, not a recommendation. Read
`docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md` §6.3 before
setting a limit, and note that `risk.symbolAllowList` must cover every
instrument any configured strategy subscribes to, that one instrument is traded
by exactly one strategy, and that the API allows at most four quote
subscriptions in total.

Nothing in this directory is a secret. The Discord webhook
(`DISCORD_WEBHOOK_TRADE_URL`, the bot's own channel), the session cookie and the
CSRF token never appear here — they arrive through the environment and the state
volume respectively.
