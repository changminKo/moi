#!/usr/bin/env bash
# OnFailure= handler: announce a failed systemd unit with its journal tail.
#   alert-unit-failed.sh <unit>        (systemd %i, e.g. moi.service; default moi.service)
# Runs under `sops exec-env` (moi-alert@.service) so DISCORD_WEBHOOK_URL is
# set. notify.sh masks credentials in the tail.
set -uo pipefail
unit="${1:-moi.service}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tail="$(journalctl -u "$unit" -n 20 --no-pager -o cat 2>/dev/null || echo '(journal unavailable)')"
exec "$here/notify.sh" fail "${unit} failed" "$tail"
