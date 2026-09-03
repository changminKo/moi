# Runbook: Discord alerts

Sources: `.github/workflows/notify.yml` (CI / image publish), `moi-status.timer`
(host + stack status every 5 minutes), `moi-alert@.service` (`OnFailure=` of
`moi.service` and `moi-status.service`), `infra/oracle/deploy.sh` (deploy
start / finished / failed). All host-side posts go through
`infra/oracle/notify.sh`, which masks credentials (URL passwords,
`KEY|TOKEN|SECRET|PASSWORD=…`, webhook URLs) and caps the text at 1,500
characters. A missing `DISCORD_WEBHOOK_URL` turns every alert into a silent
no-op; a failed post never fails a deploy (`notify.sh` is fail-open unless
`NOTIFY_STRICT=1`, which only the status check sets).

Embeds are titled in Korean; the English original sits on the first line of
the description behind a spoiler (`||…||`, Discord's 펼쳐보기), so the titles
quoted below are what the spoiler reveals. The mapping is `korean_title` in
`notify.sh` (host side) and the `case` in `notify.yml` (CI side); a title
neither knows is posted in English as it is.

| Alert (original → 한글) | Meaning | First response |
|---|---|---|
| `CI: failure` → `CI 실패` / `Publish images: failure` → `Publish images 실패` | A push to `main` (or a PR) broke a gate; a failed publish means the `main` image tag did **not** move (Trivy or build). | Open the run link. A Trivy failure names the package and fixed version: bump the base image / `apk upgrade` layer. Nothing on the host changed. |
| `알림 워크플로 실패 — …` (`Notify workflow failed`) | The embed step itself broke (jq/curl/webhook). Plain message, not an embed. | Check the webhook still exists in Discord; re-set `DISCORD_WEBHOOK` if it was rotated. |
| `deploy started: <ref>` → `배포 시작: <ref>` | `deploy.sh` began; the status timer is silenced (`/run/moi-deploy.lock`) until it ends. | Nothing. Expect `deploy finished` within ~5 minutes on the Micro. |
| `deploy failed: <ref>` → `배포 실패: <ref>` — `단계: <name> (exit <code>)` | The named step exited non-zero, the run was interrupted (130/143/129), or it ended without reaching verification (forced exit 1). `preflight`: secrets/origins/egress; `registry login + pull`: GHCR token or image tag; `migrations`: schema or datastore; `verify`: readiness / market states / placement. | `ssh` in, `sudo journalctl -u moi -n 50`. The previous release keeps serving when the failure is before `stop-then-start`; after it, follow *Rollback* in `docs/operations/deployment.md` (`MOI_IMAGE_TAG=<sha>` then `deploy.sh`). |
| `deploy finished: <sha>` → `배포 완료: <sha>` | Sent only after readiness 200, both markets NORMAL, placement enabled and every running runtime container at the checked-out revision were observed. | Nothing. |
| *(no alert)* — `deploy.sh` exited 75, 69 or 70 | These exits happen before `deploy started` is posted, so Discord stays quiet. 75: another deploy holds `/run/moi-deploy.mutex` (`FAIL: another deploy is already in progress`). 69: `flock` is missing (`util-linux`). 70: the re-exec guard `MOI_DEPLOY_REEXEC=1` arrived without the inherited mutex descriptor or marker — usually leaked from an operator shell through `sudo -E`. | 75: wait for the running deploy (`pgrep -f deploy.sh`). 69: `sudo apt-get install util-linux`. 70: `unset MOI_DEPLOY_REEXEC` and run again. |
| `moi.service failed` / `moi-status.service failed` | systemd could not start or stop the unit; the description carries the last 20 (masked) journal lines. Fires for start/stop failures only — a container that dies later is caught by the status line, not by this. | `sudo systemctl status <unit>`, `sudo docker ps -a`. Usual causes: sops key/permissions, compose interpolation (a missing secret), Docker not running; for `moi-status`: `jq`/`curl` missing or a script error. |
| `Moi status FAIL` → `Moi 상태 FAIL` | Readiness ≠ 200 (or the edge unreachable → `ready=000`, fail-closed), runtime ≠ SERVING, a market ≠ NORMAL, or placement disabled. The line shows which. | Market DEGRADED/RECOVERING → `docs/runbooks/market-data-degraded.md`. Readiness down → `sudo docker compose ... ps`, `journalctl -u moi`. Placement false with markets NORMAL → an incident is open: `GET /admin/incidents`. |
| `Moi status WARN` → `Moi 상태 WARN` | Host pressure: memory available < 15 %, swap used > 50 %, or root disk > 85 %. | Memory/swap on the 1 GB Micro: `free -h`, `docker stats`; a restart of the stack reclaims leaked memory, the durable fix is the A1 host. Disk: `docker system prune -f` (images the running release no longer uses), `journalctl --vacuum-size=200M`. |
| `Moi status recovered` → `Moi 상태 복구` | The line returned to `ok` after FAIL/WARN. | Note the duration in the incident log if one was opened. |
| `Moi status heartbeat (<level>)` → `Moi 상태 하트비트 (<level>)` | Nothing changed for 24 hours; the pipeline (timer → check → webhook) is alive. The level and colour are the *current* status, so a `(fail)` heartbeat is a day-old outage nobody acted on. | Nothing for `(ok)`; treat `(warn)`/`(fail)` as the original alert. |
| `status-check: ignoring stale deploy lock` (journal only) | `/run/moi-deploy.lock` is older than 30 minutes (`MOI_STATUS_LOCK_MAX_AGE`): a deploy died without its trap (OOM, `kill -9`, power loss). Monitoring continues. | Check `deploy.sh` really is not running (`pgrep -f deploy.sh`), then `sudo rm /run/moi-deploy.lock`. |

## What silence means

Status is announced on **change**, so a persistent bad state is posted once and
then stays quiet — silence after a FAIL means it is still failing. Silence
longer than 24 hours without a heartbeat means the pipeline is broken, not
that everything is fine: the host is down (the timer cannot report that — use
an external probe on `/health/ready`), the timer is stopped, `jq`/`curl` are
missing, or the webhook was deleted. Check, in order:

```bash
sudo systemctl list-timers moi-status.timer          # next run scheduled?
sudo journalctl -u moi-status -n 20                  # "post failed" / "jq missing"?
sudo cat /var/lib/moi/status.last                    # line 1 = last delivered status, line 2 = epoch
sudo systemctl start moi-status.service              # force a check now
ls /run/moi-deploy.lock                              # a stale lock silences the check; only deploy.sh should create it
ls /run/moi-deploy.mutex; pgrep -af deploy.sh         # the mutex file persists; the lock on it lives only while a deploy runs
```

The state file is written only after a successful post: a transition that hit
a Discord outage is retried every 5 minutes until it lands, so the *next*
delivered line is always the current one.

Manual test of the channel from the host:

```bash
sudo SOPS_AGE_KEY_FILE=/etc/moi/age.key sops exec-env /etc/moi/secrets.enc.env \
  '/opt/moi/infra/oracle/notify.sh info "test from $(hostname)"'
```
