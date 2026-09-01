/**
 * `Reporter` — the runner's Discord voice (design §3, §4.3, §7.4).
 *
 * Three properties hold, and each is a test in `reporter.test.ts`:
 *
 *   - **Masking is enforced, not remembered.** `report` accepts strings and
 *     nothing else, and every one of them passes through `maskOutbound` in
 *     `renderPayload` — the single place a payload is built. After that the
 *     finished JSON is run past `containsSecret`, and a held secret that
 *     survived means the payload is dropped instead of posted. Delivery fails
 *     open; a secret fails closed.
 *   - **Fail-open.** `report` is synchronous, returns nothing and cannot
 *     throw; delivery happens on a detached queue. A Discord outage, a revoked
 *     webhook or an empty `DISCORD_WEBHOOK_TRADE_URL` costs a counter, never a
 *     trading decision. This is the position `infra/oracle/notify.sh` takes
 *     for deploys, held for the same reason.
 *   - **Bounded, and honest about it.** Every message is admitted by the token
 *     bucket and aggregation policy in `rate-limit.ts`, so a strategy deciding
 *     every tick costs one message a minute with a count, not one message a
 *     tick. The delivery queue is bounded too, and a queue that fills with
 *     distinct alerts does lose the oldest — see `MAX_QUEUED` for the policy
 *     and for how that loss is counted, diagnosed and reported.
 *
 * The secrets to mask arrive through `secrets()`, read at send time: the
 * session cookie and CSRF token rotate, and a value captured at construction
 * would stop matching the moment the runner re-authenticates.
 */

import {
  createDiscordWebhookTransport,
  type ReportTransport,
} from './discord-transport.js';
import { LEVEL_COLOURS, type ReportEvent, type ReportField } from './events.js';
import { containsSecret, maskOutbound } from './masking.js';
import {
  ALERT_LEVELS,
  createRateLimiter,
  type RateLimiter,
  type RateLimitOptions,
} from './rate-limit.js';

/** Discord's documented embed limits, applied before anything is sent. */
const LIMIT = {
  title: 256,
  description: 1_500,
  fieldName: 256,
  fieldValue: 512,
  fields: 10,
  footer: 2_048,
} as const;

/**
 * A bound on the delivery queue: an unbounded queue during a long outage is a
 * memory leak in a process that has to outlive the outage.
 *
 * What happens at the bound is a policy, and it is this, in order:
 *
 *   1. Evict a queued routine message. Routine traffic yields to alerts, and
 *      an incoming routine message is dropped outright rather than displacing
 *      a queued alert.
 *   2. If the incoming alert's key is already waiting, drop the incoming one
 *      as a repeat — the queued entry already carries that message — and count
 *      it as suppressed, which is what it is.
 *   3. Otherwise the queue is `MAX_QUEUED` distinct alerts and the *oldest* is
 *      evicted, because in a sustained incident the newest alert describes the
 *      state an operator is acting on while the oldest is most likely already
 *      superseded.
 *
 * Step 3 is a real loss and is treated as one: it is counted separately from
 * routine drops in `alertsLost`, it emits its own diagnostic, and the next
 * posted embed carries `N alerts lost` in its footer. An earlier version of
 * this file claimed alerts were never dropped while doing exactly this
 * silently — the claim was the bug, as much as the accounting was.
 */
export const MAX_QUEUED = 100;

export interface ReporterStats {
  readonly posted: number;
  readonly suppressed: number;
  readonly dropped: number;
  /** Distinct alerts evicted from a full queue. Never folded into `dropped`. */
  readonly alertsLost: number;
  readonly blocked: number;
  readonly failed: number;
  readonly queued: number;
}

export interface Reporter {
  /** Fire-and-forget. Synchronous, never throws, never blocks a decision. */
  report(event: ReportEvent): void;
  /** Drains what the budget currently allows. For shutdown and for tests. */
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): ReporterStats;
}

export interface ReporterOptions {
  /** `DISCORD_WEBHOOK_TRADE_URL`. Empty disables the reporter entirely. */
  readonly webhookUrl?: string;
  /** Overrides the Discord transport; the tests' loopback fake uses this. */
  readonly transport?: ReportTransport;
  /** Read at send time, because the session cookie and CSRF token rotate. */
  readonly secrets?: () => readonly string[];
  /** Footer prefix, e.g. the container hostname. */
  readonly source?: string;
  readonly now?: () => number;
  readonly rateLimit?: Partial<RateLimitOptions>;
  /**
   * The masking function. Injectable only so the tripwire below can be proven
   * to fire — replace it and `containsSecret` still refuses to let the payload
   * out. Production has no reason to pass it.
   */
  readonly mask?: (text: string, secrets: readonly string[]) => string;
  /** Diagnostics carry a counter and a status, never reported content. */
  readonly onDiagnostic?: (line: string) => void;
}

interface Pending {
  readonly event: ReportEvent;
  readonly key: string;
}

const clamp = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function createReporter(options: ReporterOptions = {}): Reporter {
  const {
    webhookUrl = '',
    secrets = () => [],
    source = 'moi-bot',
    now = () => Date.now(),
    mask = maskOutbound,
    onDiagnostic = () => {},
  } = options;

  const enabled = webhookUrl.length > 0 || options.transport !== undefined;
  const transport =
    options.transport ??
    (webhookUrl.length > 0
      ? createDiscordWebhookTransport({ webhookUrl })
      : undefined);
  const limiter: RateLimiter = createRateLimiter(options.rateLimit);

  const queue: Pending[] = [];
  let posted = 0;
  let suppressed = 0;
  let dropped = 0;
  let alertsLost = 0;
  let alertsLostPending = 0;
  let blocked = 0;
  let failed = 0;
  let draining: Promise<void> | undefined;
  let closed = false;

  const renderPayload = (
    event: ReportEvent,
    note: string,
  ): { payload: unknown; body: string; held: readonly string[] } => {
    const held = secrets();
    const safe = (text: string, max: number) => clamp(mask(text, held), max);
    const fields = (event.fields ?? [])
      .slice(0, LIMIT.fields)
      .map((field: ReportField) => ({
        name: safe(field.name, LIMIT.fieldName),
        value: safe(field.value, LIMIT.fieldValue),
        inline: true,
      }));
    const footer = safe(`${source} · ${event.kind}${note}`, LIMIT.footer);
    const payload = {
      embeds: [
        {
          title: safe(event.title, LIMIT.title),
          ...(event.description === undefined
            ? {}
            : { description: safe(event.description, LIMIT.description) }),
          color: LEVEL_COLOURS[event.level],
          ...(fields.length > 0 ? { fields } : {}),
          footer: { text: footer },
          timestamp: new Date(now()).toISOString(),
        },
      ],
    };
    return { payload, body: JSON.stringify(payload), held };
  };

  /**
   * A diagnostic goes to the runner's log, which AGENTS.md hard rule 2 covers
   * as surely as the Discord channel does — and the event name it carries is
   * caller-supplied text. It is masked with the held secrets like everything
   * else, never with the injected `mask`: the tripwire's whole purpose is to
   * report that `mask` let something through.
   */
  const diagnose = (event: ReportEvent, detail: string): void => {
    onDiagnostic(`reporter: ${maskOutbound(event.kind, secrets())} ${detail}`);
  };

  const deliver = async (event: ReportEvent, note: string): Promise<void> => {
    const { payload, body, held } = renderPayload(event, note);
    // The tripwire. Masking is a moving target — a new secret shape, a new
    // rule — so the finished bytes are checked, and a survivor is never sent.
    if (containsSecret(body, held)) {
      blocked += 1;
      diagnose(event, 'was dropped: a masked secret survived rendering');
      return;
    }
    if (transport === undefined) return;
    const result = await transport.send(payload);
    if (result.delivered) {
      posted += 1;
      return;
    }
    failed += 1;
    diagnose(event, `was not delivered (${result.reason})`);
  };

  const drainOnce = async (): Promise<void> => {
    while (queue.length > 0) {
      const head = queue[0];
      if (head === undefined) break;
      const verdict = limiter.admit(
        { level: head.event.level, key: head.key },
        now(),
      );
      if (verdict.kind === 'defer') break;
      queue.shift();
      if (verdict.kind === 'suppress') {
        suppressed += 1;
        continue;
      }
      if (verdict.kind === 'drop') {
        dropped += 1;
        continue;
      }
      const lostNow = alertsLostPending;
      alertsLostPending = 0;
      // `suppressed` is a fact about *this* message — repeats of its own key
      // folded into it. `dropped` and `alertsLost` are facts about the
      // channel: the bucket and the queue are shared, so the counts belong to
      // whatever message happens to carry them out, not to its subject. They
      // are labelled apart so a session-swap warn cannot be misread as having
      // itself dropped three things.
      const channel = [
        verdict.dropped > 0 ? `${verdict.dropped} routine dropped` : '',
        lostNow > 0 ? `${lostNow} alerts lost` : '',
      ].filter((part) => part.length > 0);
      const parts = [
        verdict.suppressed > 0 ? `+${verdict.suppressed} suppressed` : '',
        channel.length > 0 ? `channel: ${channel.join(', ')}` : '',
      ].filter((part) => part.length > 0);
      await deliver(
        head.event,
        parts.length > 0 ? ` · ${parts.join(' · ')}` : '',
      );
    }
  };

  /**
   * Makes room for `event` in a full queue, or refuses it. Returns false when
   * the event itself is the one that goes. See `MAX_QUEUED` for the policy.
   */
  const admitToFullQueue = (event: ReportEvent, key: string): boolean => {
    const routine = queue.findIndex(
      (entry) => entry.event.level === 'info' || entry.event.level === 'ok',
    );
    if (routine >= 0) {
      queue.splice(routine, 1);
      dropped += 1;
      return true;
    }
    if (!ALERT_LEVELS.has(event.level)) {
      dropped += 1;
      return false;
    }
    if (queue.some((entry) => entry.key === key)) {
      suppressed += 1;
      return false;
    }
    const [lost] = queue.splice(0, 1);
    alertsLost += 1;
    alertsLostPending += 1;
    if (lost !== undefined)
      diagnose(lost.event, 'was lost: the alert queue is full of alerts');
    return true;
  };

  const kick = (): void => {
    if (draining !== undefined) return;
    draining = drainOnce()
      .catch(() => {
        // Unreachable by construction — deliver swallows everything — but a
        // reporter may not become a source of unhandled rejections.
        failed += 1;
      })
      .finally(() => {
        draining = undefined;
      });
  };

  return {
    report(event) {
      if (closed) return;
      if (!enabled) {
        dropped += 1;
        return;
      }
      const key = event.dedupeKey ?? event.kind;
      if (queue.length >= MAX_QUEUED && !admitToFullQueue(event, key)) return;
      queue.push({ event, key });
      kick();
    },
    async flush() {
      kick();
      await draining;
      // A pass can enqueue nothing new, but a caller that reported during the
      // drain deserves its message before flush resolves.
      if (queue.length > 0 && draining === undefined) {
        kick();
        await draining;
      }
    },
    async close() {
      await this.flush();
      closed = true;
    },
    stats: () => ({
      posted,
      suppressed,
      dropped,
      alertsLost,
      blocked,
      failed,
      queued: queue.length,
    }),
  };
}
