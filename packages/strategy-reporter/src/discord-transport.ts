/**
 * The Discord webhook transport.
 *
 * Fail-open, the same position `infra/oracle/notify.sh` takes for deploys
 * ("Never able to fail the deploy"): a Discord outage, a revoked webhook or a
 * DNS failure must never fail a trading decision or bring the runner down.
 * `send` therefore resolves with a result and never rejects — there is no
 * error path a caller could accidentally propagate into the decision loop.
 *
 * The webhook URL is a secret. It is held here, never logged, and never put
 * into a returned reason; a caller that prints a `SendResult` prints a status
 * code, not a credential.
 */

export interface SendResult {
  readonly delivered: boolean;
  readonly status?: number;
  /** Safe to log: a status or an error class, never the URL or a body. */
  readonly reason?: string;
}

export interface ReportTransport {
  send(payload: unknown): Promise<SendResult>;
}

export interface DiscordWebhookTransportOptions {
  readonly webhookUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Injected so a test does not spend `retry_after` in real time. */
  readonly wait?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Discord's own ceiling on how long it asks a client to back off. */
const MAX_RETRY_WAIT_MS = 5_000;

async function retryAfterMs(response: Response): Promise<number | undefined> {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1_000, MAX_RETRY_WAIT_MS);
  try {
    const body = (await response.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === 'number' && body.retry_after >= 0)
      return Math.min(body.retry_after * 1_000, MAX_RETRY_WAIT_MS);
  } catch {
    // A 429 without a parseable body still deserves one paced retry.
  }
  return undefined;
}

export function createDiscordWebhookTransport(
  options: DiscordWebhookTransportOptions,
): ReportTransport {
  const {
    webhookUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    wait = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.();
      }),
  } = options;

  const post = async (body: string): Promise<Response> =>
    fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

  return {
    async send(payload) {
      const body = JSON.stringify(payload);
      try {
        let response = await post(body);
        // Exactly one paced retry. The token bucket keeps the runner an order
        // of magnitude under the webhook budget, so a 429 means someone else
        // is posting to the channel — worth one retry, not a retry storm.
        if (response.status === 429) {
          const delay = await retryAfterMs(response);
          if (delay === undefined)
            return { delivered: false, status: 429, reason: 'rate limited' };
          await wait(delay);
          response = await post(body);
        }
        if (response.ok) return { delivered: true, status: response.status };
        return {
          delivered: false,
          status: response.status,
          reason: `webhook answered HTTP ${response.status}`,
        };
      } catch (error) {
        // The message of a fetch failure can carry the URL, so only the error
        // class crosses this boundary.
        const name = error instanceof Error ? error.name : 'Error';
        return { delivered: false, reason: `webhook unreachable (${name})` };
      }
    },
  };
}
