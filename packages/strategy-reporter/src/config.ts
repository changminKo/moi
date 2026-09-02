/**
 * Reading the reporter's webhook out of the environment.
 *
 * The runner posts to its **own** channel. The approved-decisions table of the
 * strategy-runner design names `DISCORD_WEBHOOK_TRADE_URL` and requires it to
 * be a different channel from the operational `DISCORD_WEBHOOK_URL` that
 * `infra/oracle/notify.sh` uses, so trading noise cannot bury an incident
 * alert. This module is where that separation is enforced rather than trusted:
 * the operational variable is never read as a fallback, and the same URL under
 * both names is refused.
 *
 * A missing variable is not an error. Like `notify.sh`, the reporter is a
 * silent no-op without a webhook — reporting may not be a reason a runner
 * refuses to start.
 */

export const TRADE_WEBHOOK_VARIABLE = 'DISCORD_WEBHOOK_TRADE_URL';
export const OPERATIONAL_WEBHOOK_VARIABLE = 'DISCORD_WEBHOOK_URL';

const DISCORD_WEBHOOK =
  /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export type ReporterConfigResult =
  | { readonly ok: true; readonly webhookUrl: string }
  /** Never carries the rejected value: a problem line may be logged. */
  | { readonly ok: false; readonly problem: string };

export function readReporterConfig(
  env: Readonly<Record<string, string | undefined>>,
): ReporterConfigResult {
  const raw = env[TRADE_WEBHOOK_VARIABLE]?.trim() ?? '';
  if (raw.length === 0) return { ok: true, webhookUrl: '' };

  if (!DISCORD_WEBHOOK.test(raw))
    return {
      ok: false,
      problem: `${TRADE_WEBHOOK_VARIABLE} must be an https Discord webhook URL`,
    };

  if (raw === env[OPERATIONAL_WEBHOOK_VARIABLE]?.trim())
    return {
      ok: false,
      problem: `${TRADE_WEBHOOK_VARIABLE} must be a different channel from ${OPERATIONAL_WEBHOOK_VARIABLE}`,
    };

  return { ok: true, webhookUrl: raw };
}
