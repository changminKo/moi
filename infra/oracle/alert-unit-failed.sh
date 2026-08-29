#!/usr/bin/env bash
# OnFailure= handler: announce a failed systemd unit with its journal tail.
#   alert-unit-failed.sh <unit>        (default: moi)
# Runs under `sops exec-env` (moi-alert.service, moi-status-alert.service) so
# DISCORD_WEBHOOK_URL is set. notify.sh masks credentials in the tail.
set -uo pipefail
unit="${1:-moi}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tail="$(journalctl -u "$unit" -n 20 --no-pager -o cat 2>/dev/null || echo '(journal unavailable)')"
exec "$here/notify.sh" fail "${unit}.service failed" "$tail"
