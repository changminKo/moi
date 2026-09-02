import { basename } from 'node:path';
import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { OrderGateway } from '../gateway/order-gateway.js';
import type { Reporter, ReportFields } from '../reporter.js';
import { isOpenOrder } from '../risk/risk-gate.js';
import type { JsonCell } from '../state/json-cell.js';
import type { DecisionKind } from '../state/state-store.js';

/**
 * The runner-wide kill switch (design §6, §7.2; the phase-D design document
 * `2026-09-02-moi-strategy-runner-kill-switch-design.md`).
 *
 * One latch, four ways to trip it, and what tripping does: the latch is written
 * to `kill-switch.json` **first**, then reported once, then every resting order
 * is cancelled through the ordinary gateway path, and from then on the gateway's
 * barrier settles every `place` as `halted` while a `cancel` still goes out. The
 * runner stays up — the stream keeps delivering fills to the journal — and says
 * so every `HEARTBEAT_MS`. Clearing it is a person's act: delete the file and
 * restart. A latch that lifted itself would be a bot that resumed trading on
 * the same evidence it stopped on.
 *
 * ## Why the file comes first
 *
 * For the same reason a decision is on disk before it is submitted (§6.2): a
 * crash between "decided to stop" and "stopped" must leave a runner that comes
 * back stopped. `JsonCell.write` is an atomic replace, so the file is either
 * the whole latch or absent.
 *
 * ## Why the sweep goes through the gateway
 *
 * Each cancel is a recorded decision with a deterministic id,
 * `kill:{engagedAt}:{orderId}`. That buys three things at once: an audit line
 * per cancel, idempotency across a re-sweep (`appendDecision` writes nothing for
 * an id it has seen), and recovery — a cancel that failed is a pending decision,
 * and pending cancels are what `recoverPending` resubmits on the next start. The
 * sweep has no cancellation code of its own to get wrong.
 *
 * ## Why it reports on the transition only
 *
 * A fill wedge re-throws on every reconnect, and each throw calls `engage`
 * again. The second and later calls are silent; an embed per reconnect would be
 * the noise that hides the one that mattered.
 */

export const MAX_SWEEP_PASSES = 5;
export const HEARTBEAT_MS = 30 * 60 * 1_000;

export type KillSwitchSource =
  | 'loss-limit'
  | 'submission-failures'
  | 'fill-wedge'
  | 'operator';

export interface Engagement {
  readonly engagedAt: string;
  readonly source: KillSwitchSource;
  readonly reason: string;
}

/** The half a trip source needs. `FillProcessor` takes this rather than the class. */
export interface KillSwitchTrigger {
  engage(
    source: KillSwitchSource,
    reason: string,
    fields?: ReportFields,
  ): Promise<void>;
}

export interface KillSwitchOptions {
  readonly cell: JsonCell;
  readonly gateway: Pick<OrderGateway, 'idle' | 'record' | 'submit'>;
  /** The ledger's own view, read fresh on every sweep pass. */
  readonly portfolio: () => Promise<BrokerPortfolio>;
  readonly reporter: Reporter;
  readonly now?: () => number;
}

const SOURCES: ReadonlySet<unknown> = new Set<KillSwitchSource>([
  'loss-limit',
  'submission-failures',
  'fill-wedge',
  'operator',
]);

/**
 * The reason an operator latch is given when the file says nothing usable. A
 * kill-switch file the runner cannot read is not a reason to keep trading.
 */
const OPERATOR_FILE_PRESENT = 'operator file present';

export class KillSwitch implements KillSwitchTrigger {
  readonly #cell: JsonCell;
  readonly #gateway: Pick<OrderGateway, 'idle' | 'record' | 'submit'>;
  readonly #portfolio: () => Promise<BrokerPortfolio>;
  readonly #reporter: Reporter;
  readonly #now: () => number;
  #engagement: Engagement | null;
  #sweep: Promise<void> | null = null;
  #lastHeartbeatAt = 0;

  constructor(options: KillSwitchOptions) {
    this.#cell = options.cell;
    this.#gateway = options.gateway;
    this.#portfolio = options.portfolio;
    this.#reporter = options.reporter;
    this.#now = options.now ?? Date.now;
    this.#engagement = this.#readLatch();
  }

  get engaged(): boolean {
    return this.#engagement !== null;
  }

  get engagement(): Engagement | null {
    return this.#engagement;
  }

  /** The submission barrier: a `cancel` always passes, a `place` only while disengaged. */
  permits(kind: DecisionKind): boolean {
    return kind === 'cancel' || this.#engagement === null;
  }

  engage(
    source: KillSwitchSource,
    reason: string,
    fields: ReportFields = {},
  ): Promise<void> {
    if (this.#engagement !== null) {
      return this.#sweep ?? Promise.resolve();
    }

    const engagement: Engagement = Object.freeze({
      engagedAt: new Date(this.#now()).toISOString(),
      source,
      reason,
    });

    // The first durable act. Everything after this line can fail and the next
    // start still comes up engaged.
    this.#cell.write({ ...engagement });
    this.#engagement = engagement;
    this.#lastHeartbeatAt = this.#now();
    this.#reporter.report(
      'error',
      'the kill switch is engaged; new orders are refused and resting orders are being cancelled',
      { source, reason, ...fields },
    );
    this.#sweep = this.#sweepGuarded(engagement);

    return this.#sweep;
  }

  /**
   * An operator engages the switch by writing `{"reason": "…"}` to the latch
   * file; the runner notices on its next cycle. A file that is present but
   * unreadable, or has no reason, still engages. Once engaged this is a no-op:
   * the file on disk is then the runner's own, and deleting it while running
   * does not lift the latch — that takes a restart, by design, because a
   * half-cleared switch would be a half-trading bot.
   */
  async observeOperatorFile(): Promise<void> {
    if (this.#engagement !== null) {
      return;
    }

    const saved = this.#readCell();

    if (saved === null) {
      return;
    }

    await this.engage('operator', reasonIn(saved));
  }

  /**
   * What `start()` does with a latch it found on disk: say so, and sweep again.
   * The re-sweep is what closes the gap a crash *during* the first sweep leaves
   * — cancels that were recorded are pending and `recoverPending` has already
   * resubmitted them, but an order the sweep never reached is only caught by
   * reading the portfolio again. The ids are the same, so nothing is recorded or
   * submitted twice.
   */
  async resume(): Promise<void> {
    const engagement = this.#engagement;

    if (engagement === null) {
      return;
    }

    this.#lastHeartbeatAt = this.#now();
    this.#reporter.report(
      'error',
      `the kill switch is still engaged from a previous run; delete ${basename(this.#cell.path)} and restart to resume trading`,
      {
        source: engagement.source,
        reason: engagement.reason,
        engagedAt: engagement.engagedAt,
      },
    );
    this.#sweep = this.#sweepGuarded(engagement);

    await this.#sweep;
  }

  /** One `warn` per `HEARTBEAT_MS` while engaged. The transition itself is reported by `engage`. */
  heartbeat(): void {
    const engagement = this.#engagement;

    if (engagement === null) {
      return;
    }

    const now = this.#now();

    if (now - this.#lastHeartbeatAt < HEARTBEAT_MS) {
      return;
    }

    this.#lastHeartbeatAt = now;
    this.#reporter.report('warn', 'the kill switch is still engaged', {
      source: engagement.source,
      reason: engagement.reason,
      engagedAt: engagement.engagedAt,
    });
  }

  /** The cell's content, with "unreadable" folded into "present and empty". */
  #readCell(): Readonly<Record<string, unknown>> | null {
    try {
      return this.#cell.read();
    } catch {
      return {};
    }
  }

  #readLatch(): Engagement | null {
    const saved = this.#readCell();

    if (saved === null) {
      return null;
    }

    if (
      typeof saved.engagedAt === 'string' &&
      SOURCES.has(saved.source) &&
      typeof saved.reason === 'string'
    ) {
      return Object.freeze({
        engagedAt: saved.engagedAt,
        source: saved.source as KillSwitchSource,
        reason: saved.reason,
      });
    }

    // An operator wrote it (or nobody could read it) before this start: adopt
    // it as an operator engagement and write it back in the runner's own shape,
    // so the next reader sees one form.
    const adopted: Engagement = Object.freeze({
      engagedAt: new Date(this.#now()).toISOString(),
      source: 'operator',
      reason: reasonIn(saved),
    });

    this.#cell.write({ ...adopted });

    return adopted;
  }

  async #sweepGuarded(engagement: Engagement): Promise<void> {
    try {
      await this.#runSweep(engagement);
    } catch (error) {
      // The latch is down regardless; the barrier holds. What failed is the
      // cleanup, and the next start's `resume` tries it again.
      this.#reporter.report('error', 'the cancel sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #runSweep(engagement: Engagement): Promise<void> {
    // An order that was mid-submission when the latch came down has to be in
    // the snapshot this reads, or the sweep misses it.
    await this.#gateway.idle();

    let resting = await this.#resting();
    let passes = 0;

    while (resting.length > 0 && passes < MAX_SWEEP_PASSES) {
      passes += 1;

      for (const orderId of resting) {
        const record = this.#gateway.record(
          'kill-switch',
          {
            kind: 'cancel',
            orderId,
            reason: `kill switch: ${engagement.reason}`,
          },
          null,
          { decisionId: `kill:${engagement.engagedAt}:${orderId}` },
        );

        if (record !== null) {
          await this.#gateway.submit(record);
        }
      }

      resting = await this.#resting();
    }

    if (resting.length === 0) {
      this.#reporter.report(
        'info',
        'the cancel sweep found no resting orders',
        { passes },
      );

      return;
    }

    this.#reporter.report(
      'error',
      'the cancel sweep left resting orders after its last pass',
      { passes, orderIds: resting.join(',') },
    );
  }

  async #resting(): Promise<readonly string[]> {
    const portfolio = await this.#portfolio();

    return portfolio.activeOrders.filter(isOpenOrder).map((order) => order.id);
  }
}

const reasonIn = (saved: Readonly<Record<string, unknown>>): string =>
  typeof saved.reason === 'string' && saved.reason.trim().length > 0
    ? saved.reason
    : OPERATOR_FILE_PRESENT;
