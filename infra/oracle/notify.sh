#!/usr/bin/env bash
# Post one Discord embed. Alerting must never break a deploy or a timer run:
# a missing DISCORD_WEBHOOK_URL is a silent no-op and, by default, a failed
# post exits 0. With NOTIFY_STRICT=1 a failed (or impossible) post exits 1 so
# a caller that needs delivery — the status check — can retry later.
#
#   notify.sh <ok|warn|fail|info> <title> [description]
#
# The operator reads Korean. A title whose shape `korean_title` knows is posted
# in Korean with the English original on the first line of the description
# behind a Discord spoiler (`||…||`, the client's 펼쳐보기) — the original is
# what the runbook quotes and what the tests of the producers assert on. A
# title the table does not know is posted as it is: an English embed beats a
# wrong Korean one, and the fix is one more case below.
#
# The webhook URL is a secret (sops file on the host, `DISCORD_WEBHOOK_URL`);
# it is read from the environment only and never printed. Title and
# description are masked before they leave the host: credentials in URLs,
# KEY/TOKEN/SECRET/PASSWORD-style assignments and Discord webhook URLs.
set -uo pipefail
level="${1:-}"; title="${2:-}"; description="${3:-}"
strict="${NOTIFY_STRICT:-0}"
case "$level" in
  ok)   color=3066993 ;;   # 0x2ecc71
  warn) color=16098596 ;;  # 0xf5a524
  fail) color=15026253 ;;  # 0xe5484d
  info) color=5793266 ;;   # 0x5865f2
  *) echo "notify: usage: notify.sh <ok|warn|fail|info> <title> [description]" >&2; exit 2 ;;
esac
[ -n "$title" ] || { echo "notify: title required" >&2; exit 2; }
[ -n "${DISCORD_WEBHOOK_URL:-}" ] || exit 0

soft_fail() { echo "notify: $1" >&2; [ "$strict" = 1 ] && exit 1; exit 0; }
command -v jq >/dev/null 2>&1 || soft_fail "jq missing, nothing posted (${level}: ${title})"
command -v curl >/dev/null 2>&1 || soft_fail "curl missing, nothing posted (${level}: ${title})"
# perl is the masker. Without it the mask pipeline yields nothing, so every
# field comes out empty and the alert posts as a blank embed — measured, not
# assumed. That is not a leak, but a silently blank alert is worse than a named
# refusal: an operator reads "nothing is wrong" from a message that means the
# host lost its masker. So say so and post nothing.
command -v perl >/dev/null 2>&1 || soft_fail "perl missing, nothing posted (${level}: ${title})"

# Masking (AGENTS.md rule 2: secrets never reach chat). Applied to every
# outbound field; the journal tail sent by alert-unit-failed.sh can carry
# connection strings or environment dumps.
#
# The session, CSRF, Set-Cookie, idempotency-key and Bearer rules come from
# strategy-runner design §7.4, which requires the same patterns on both sides:
# here and in the runner's reporter (packages/strategy-reporter,
# src/masking.ts). infra/oracle/notify.test.mjs holds this half to it.
#
# perl, not sed, and `-0777` so the whole input is one record. sed works a line
# at a time, so every rule below used to match only while the secret sat on the
# same line as its marker — and a journal tail is many lines, with wrapped ones
# putting a value on the next. `\s*` between a marker and its value is
# deliberate for the same reason: it crosses the newline. Over-masking is the
# safe direction here. This also gives the same whole-text semantics the
# JavaScript masker has, which is what makes "the same patterns on both sides"
# true rather than approximate.
mask() {
  printf %s "$1" | perl -0777 -pe '
    s{https?://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\S*}{<webhook>}gi;
    s{([a-zA-Z][a-zA-Z0-9+.-]*://[^/:@\s]+:)[^@\s]+\@}{$1***\@}g;
    s{\bBearer\s+\S+}{Bearer ***}gi;
    s{(moi_session=)\s*[^;\s,"\x27]*}{$1***}gi;
    s{\b(set-cookie|x-csrf-token|csrf-token|idempotency-key)(\s*[:=]\s*)\S*}{$1$2***}gi;
    s{([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|COOKIE)[A-Za-z0-9_]*\s*[=:]\s*)\S+}{$1***}gi;
  '
}
# The producers' title shapes (deploy-lib.sh, status-check.sh,
# alert-unit-failed.sh), English → Korean. The variable part is carried over.
korean_title() {
  case "$1" in
    'deploy started: '*)  printf '배포 시작: %s' "${1#deploy started: }" ;;
    'deploy finished: '*) printf '배포 완료: %s' "${1#deploy finished: }" ;;
    'deploy failed: '*)   printf '배포 실패: %s' "${1#deploy failed: }" ;;
    'Moi status recovered') printf 'Moi 상태 복구' ;;
    'Moi status heartbeat ('*')')
      level_in_title="${1#Moi status heartbeat (}"
      printf 'Moi 상태 하트비트 (%s)' "${level_in_title%)}" ;;
    'Moi status '*) printf 'Moi 상태 %s' "${1#Moi status }" ;;
    *' failed') printf '%s 실패' "${1% failed}" ;;
    *) return 1 ;;
  esac
}
if korean="$(korean_title "$title")"; then
  # Original first, so the 1,500-character cap below trims the journal tail,
  # never the line that says what this embed was in English.
  [ -n "$description" ] && description=$'\n'"$description"
  description="||${title}||${description}"
  title="$korean"
fi

title="$(mask "$title")"
# Discord caps descriptions at 4096 characters; a journal tail needs far less.
description="$(mask "$description" | head -c 1500)"

payload="$(jq -cn \
  --arg title "$title" \
  --arg description "$description" \
  --argjson color "$color" \
  --arg footer "$(hostname) · $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{embeds: [{title: $title, description: $description, color: $color, footer: {text: $footer}}]}' 2>/dev/null)"
[ -n "$payload" ] || soft_fail "empty payload, nothing posted (${level}: ${title})"

# The URL travels to curl as a config file on stdin (-K -), not as an argument
# visible in the process list.
if ! printf 'url = "%s"\n' "$DISCORD_WEBHOOK_URL" \
   | curl -fsS --max-time 10 -o /dev/null -K - -H 'Content-Type: application/json' -d "$payload"; then
  soft_fail "post failed (${level}: ${title})"
fi
exit 0
