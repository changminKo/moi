# Runbook: Discord alerts

Sources: `.github/workflows/notify.yml` (CI / image publish), `moi-status.timer`
(host + stack status every 5 minutes), `moi-alert.service` (`OnFailure=` of
`moi.service`), `infra/oracle/deploy.sh` (deploy start / finished / failed).
All host-side posts go through `infra/oracle/notify.sh`; a missing
`DISCORD_WEBHOOK_URL` turns every alert into a silent no-op and a failed post
never fails the caller.

| Alert | Meaning | First response |
|---|---|---|
| `CI: failure` / `Publish images: failure` | A push to `main` (or a PR) broke a gate; a failed publish means the `main` image tag did **not** move (Trivy or build). | Open the run link. A Trivy failure names the package and fixed version: bump the base image / `apk upgrade` layer. Nothing on the host changed. |
| `deploy started: <ref>` | `deploy.sh` began. Informational. | Nothing. Expect `deploy finished` within ~5 minutes on the Micro. |
| `deploy failed: <ref>` — `step: <name>` | The named step exited non-zero; the trap posts the last `== step` reached. `preflight`: secrets/origins/egress; `registry login + pull`: GHCR token or image tag; `migrations`: schema or datastore; `verify`: readiness / market states / placement. | `ssh` in, `sudo journalctl -u moi -n 50`. The previous release keeps serving when the failure is before `stop-then-start`; after it, follow *Rollback* in `docs/operations/deployment.md` (`MOI_IMAGE_TAG=<sha>` then `deploy.sh`). |
| `deploy finished: <sha>` | Readiness 200, both markets NORMAL, placement enabled. | Nothing. |
| `moi.service failed` | systemd could not start or stop the compose stack; the description carries the last 20 journal lines. | `sudo systemctl status moi`, `sudo docker ps -a`. Usual causes: sops key/permissions, compose interpolation (a missing secret), Docker not running. |
| `Moi status FAIL` | Readiness ≠ 200, runtime ≠ SERVING, a market ≠ NORMAL, or placement disabled. The line shows which. | Market DEGRADED/RECOVERING → `docs/runbooks/market-data-degraded.md`. Readiness down → `sudo docker compose ... ps`, `journalctl -u moi`. Placement false with markets NORMAL → an incident is open: `GET /admin/incidents`. |
| `Moi status WARN` | Host pressure: memory available < 15 %, swap used > 50 %, or root disk > 85 %. | Memory/swap on the 1 GB Micro: `free -h`, `docker stats`; a restart of the stack reclaims leaked memory, the durable fix is the A1 host. Disk: `docker system prune -f` (images the running release no longer uses), `journalctl --vacuum-size=200M`. |
| `Moi status recovered` | The line returned to `ok` after FAIL/WARN. | Note the duration in the incident log if one was opened. |

Status is only announced on **change**: a persistent bad state is posted once,
so silence after a FAIL means it is still failing. `cat /var/lib/moi/status.last`
shows the last recorded line; `sudo systemctl start moi-status.service` forces a
check; `sudo journalctl -u moi-status` shows the history.

Manual test of the channel from the host:

```bash
sudo SOPS_AGE_KEY_FILE=/etc/moi/age.key sops exec-env /etc/moi/secrets.enc.env \
  '/opt/moi/infra/oracle/notify.sh info "test from $(hostname)"'
```
