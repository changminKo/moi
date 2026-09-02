import { basename } from 'node:path';
import { maskOutbound } from '@moi/strategy-reporter';
import type { BrokerPortfolio } from '@moi/strategy-sdk';
import { DomainError } from '@moi/trading-core';
import type { OrderGateway } from '../gateway/order-gateway.js';
import type { Reporter, ReportFields } from '../reporter.js';
import { isOpenOrder } from '../risk/risk-gate.js';
import type { JsonCell } from '../state/json-cell.js';
import type { DecisionKind } from '../state/state-store.js';

/**
 * The runner-wide kill switch (design §6, §7.2; the phase-D design document
 * `2026-09-02-moi-strategy-runner-kill-switch-design.md`).
 *
 * One latch, four ways to trip it, and what tripping does: the in-memory
 * barrier closes, the latch is written to `kill-switch.json`, it is reported
 * once, every resting order is cancelled through the ordinary gateway path, and
 * from then on the gateway's barrier settles every `place` as `halted` while a
 * `cancel` still goes out. The runner stays up — the stream keeps delivering
 * fills to the journal — and says so every `HEARTBEAT_MS`. Clearing it is a
 * person's act: delete the file and restart. A latch that lifted itself would
 * be a bot that resumed trading on the same evidence it stopped on.
 *
 * ## Why the memory comes before the file, and the file before the report
 *
 * For the same reason a decision is on disk before it is submitted (§6.2): a
 * crash between "decided to stop" and "stopped" must leave a runner that comes
 * back stopped, so the file is written before anything is said or swept.
 * `JsonCell.write` is an atomic replace, so the file is either the whole latch
 * or absent. But the in-memory barrier closes *before* the write: a disk that
 * refuses the file must not leave the runner trading. A failed write is
 * reported, holds in memory, and is retried on every later observation — the
 * one state worse than "engaged but not persisted" is "asked to engage and
 * still placing".
 *
 * ## Why the sweep goes through the gateway
 *
 * Each cancel is a recorded decision with a deterministic id,
 * `kill:{engagedAt}:{orderId}`. That buys three things at once: an audit line
 * per cancel, one decision line across a re-sweep (`appendDecision` writes
 * nothing for an id it has seen), and recovery — a cancel that failed is a
 * pending decision, and pending cancels are what `recoverPending` resubmits on
 * the next start. A re-sweep may send the same cancellation again, under the
 * same key; the ledger's idempotency makes that a replay, not a second effect.
 * The sweep has no cancellation code of its own to get wrong.
 *
 * ## Why it reports on the transition only
 *
 * A fill wedge re-throws on every reconnect, and each throw calls `engage`
 * again. The second and later calls are silent; an embed per reconnect would be
 * the noise that hides the one that mattered.
 */

export const MAX_SWEEP_PASSES = 5;
export const HEARTBEAT_MS = 30 * 60 * 1_000;
/**
 * How long the sweep waits for in-flight submissions before reading anyway.
 * `idle()` has no bound of its own — a submission inside a `Retry-After`
 * backoff holds it — and leaving resting orders out for the length of a backoff
 * is the worse failure. What settles after the cap is caught by the re-scan or
 * by the next start's `resume`.
 */
export const SWEEP_IDLE_WAIT_MS = 5_000;

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
  /** Sleeps. Injected so a test can make the idle cap elapse at once. */
  readonly wait?: (ms: number) => Promise<void>;
}

const SOURCES: ReadonlySet<unknown> = new Set<KillSwitchSource>([
  'loss-limit',
  'submission-failures',
  'fill-wedge',
  'operator',
]);

/**
 * The reason an operator latch is given when the file says nothing usable. A
 * kill-switch file the runner cannot parse is not a reason to keep trading.
 */
const OPERATOR_FILE_PRESENT = 'operator file present';

const OWN_FIELDS: ReadonlySet<string> = new Set([
  'engagedAt',
  'source',
  'reason',
]);

/** What a read of the latch file can come back as. */
type LatchRead =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'present';
      readonly value: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'unreadable'; readonly code: string };

/** The code of an error, and never its message: the message may be the server's. */
function codeOf(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }

  const errno = (error as NodeJS.ErrnoException | null)?.code;

  if (typeof errno === 'string') {
    return errno;
  }

  return error instanceof Error ? error.name : 'unknown';
}

const reasonIn = (saved: Readonly<Record<string, unknown>>): string =>
  typeof saved.reason === 'string' && saved.reason.trim().length > 0
    ? saved.reason
    : OPERATOR_FILE_PRESENT;

export class KillSwitch implements KillSwitchTrigger {
  readonly #cell: JsonCell;
  readonly #gateway: Pick<OrderGateway, 'idle' | 'record' | 'submit'>;
  readonly #portfolio: () => Promise<BrokerPortfolio>;
  readonly #reporter: Reporter;
  readonly #now: () => number;
  readonly #wait: (ms: number) => Promise<void>;
  #engagement: Engagement | null;
  /** Whether the latch on disk matches `#engagement`. False after a failed write. */
  #persisted = false;
  /** An operator's own fields from an adopted file, carried through the normalising write. */
  #carried: Readonly<Record<string, unknown>> = {};
  #sweep: Promise<void> | null = null;
  #lastHeartbeatAt = 0;
  /** Set while the latch file is unreadable, so the fault is reported on the transition only. */
  #readFault = false;
  /** Likewise for a latch that cannot be written. */
  #persistFault = false;
  /**
   * True only for a latch read off disk at construction and not yet announced
   * by `resume`. A latch that came down in this run has already been reported
   * by `engage` and is already sweeping; `resume` has nothing to add to it.
   */
  #pendingResume: boolean;

  constructor(options: KillSwitchOptions) {
    this.#cell = options.cell;
    this.#gateway = options.gateway;
    this.#portfolio = options.portfolio;
    this.#reporter = options.reporter;
    this.#now = options.now ?? Date.now;
    this.#wait =
      options.wait ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#engagement = this.#readLatch();
    this.#pendingResume = this.#engagement !== null;
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
      // Masked before it can reach the file: the report path masks on its own,
      // the cell does not, and a future trip source may hand over a message.
      reason: maskOutbound(reason),
    });

    // Memory first — the barrier is closed from this line whatever the disk
    // does — then the file, then the report. A crash after the write leaves a
    // runner that comes back engaged; a write that fails leaves one that says so.
    this.#engagement = engagement;
    this.#lastHeartbeatAt = this.#now();
    this.#persist();
    this.#reporter.report(
      'error',
      'the kill switch is engaged; new orders are refused and resting orders are being cancelled',
      { source, reason: engagement.reason, ...fields },
    );
    this.#sweep = this.#sweepGuarded(engagement);

    return this.#sweep;
  }

  /**
   * An operator engages the switch by writing `{"reason": "…"}` to the latch
   * file; the runner notices on its next cycle. A file that is present but
   * unparseable, or has no reason, still engages. Once engaged this is a no-op
   * apart from retrying a write that failed: the file on disk is then the
   * runner's own, and deleting it while running does not lift the latch — that
   * takes a restart, by design, because a half-cleared switch would be a
   * half-trading bot.
   */
  async observeOperatorFile(): Promise<void> {
    if (this.#engagement !== null) {
      if (!this.#persisted) {
        this.#persist();
      }

      return;
    }

    const read = this.#readCell();

    if (read.kind !== 'present') {
      return;
    }

    await this.engage('operator', reasonIn(read.value));
  }

  /**
   * What `start()` does with a latch it found on disk: say so, and sweep again.
   * The re-sweep is what closes the gap a crash *during* the first sweep leaves
   * — cancels that were recorded are pending and `recoverPending` has already
   * resubmitted them, but an order the sweep never reached is only caught by
   * reading the portfolio again. The ids are the same, so no second decision
   * line is written.
   *
   * Silent for a latch that came down in this run (`recoverPending` can trip
   * the failure counter before `start()` reaches here): the operator was told
   * by `engage`, there is no stale file to point them at, and a second sweep
   * would run beside the first. Speaks once — a second call is a no-op.
   */
  async resume(): Promise<void> {
    const engagement = this.#engagement;

    if (engagement === null || !this.#pendingResume) {
      return;
    }

    this.#pendingResume = false;
    this.#lastHeartbeatAt = this.#now();

    // An adopted operator file is normalised here, not in the constructor:
    // building a supervisor must not rewrite an operator's file.
    if (!this.#persisted) {
      this.#persist();
    }

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

  /**
   * Three answers, not two. Absent is absent. A file that is there but is not
   * JSON, or not an object, is *present* — an operator's hand-written latch
   * that the runner cannot parse is still a latch (fail closed). Anything else
   * — `EACCES`, `EIO`, `EISDIR`, a file table full — is a fault of the moment,
   * reported once and read again next cycle; a passing I/O error must not stop
   * a bot nobody is watching for good.
   */
  #readCell(): LatchRead {
    try {
      const value = this.#cell.read();

      this.#readFault = false;

      return value === null ? { kind: 'absent' } : { kind: 'present', value };
    } catch (error) {
      if (error instanceof DomainError) {
        this.#readFault = false;

        return { kind: 'present', value: {} };
      }

      const code = codeOf(error);

      // Once per fault, not once per cycle: this is read every second.
      if (!this.#readFault) {
        this.#readFault = true;
        this.#reporter.report(
          'warn',
          'the kill-switch file could not be read and will be retried next cycle',
          { code },
        );
      }

      return { kind: 'unreadable', code };
    }
  }

  /**
   * Writes the latch, or says why it could not. Never throws: the memory
   * barrier is already closed by the time this runs, and a caller inside a
   * `catch` block — the fill processor — must keep its own error.
   */
  #persist(): void {
    const engagement = this.#engagement;

    if (engagement === null) {
      return;
    }

    try {
      this.#cell.write({ ...this.#carried, ...engagement });
      this.#persisted = true;
      this.#persistFault = false;
    } catch (error) {
      this.#persisted = false;

      // Retried every observation; reported once per fault, not once a second.
      if (!this.#persistFault) {
        this.#persistFault = true;
        this.#reporter.report(
          'error',
          'the kill switch could not be persisted; it holds in memory but a restart would come up trading',
          { code: codeOf(error) },
        );
      }
    }
  }

  #readLatch(): Engagement | null {
    const read = this.#readCell();

    if (read.kind === 'absent') {
      return null;
    }

    if (read.kind === 'unreadable') {
      // At start the question is not "is the disk having a moment" but "is
      // there a latch": something is at the path and the runner cannot tell
      // what. Fail closed — engaged in memory, written back by `resume` if the
      // disk allows it by then.
      this.#persisted = false;

      return Object.freeze({
        engagedAt: new Date(this.#now()).toISOString(),
        source: 'operator',
        reason: `${OPERATOR_FILE_PRESENT} but unreadable (${read.code})`,
      });
    }

    const saved = read.value;

    if (
      typeof saved.engagedAt === 'string' &&
      SOURCES.has(saved.source) &&
      typeof saved.reason === 'string'
    ) {
      this.#persisted = true;

      return Object.freeze({
        engagedAt: saved.engagedAt,
        source: saved.source as KillSwitchSource,
        // The file is not a trusted source either: it was written by a runner,
        // but it could have been edited since.
        reason: maskOutbound(saved.reason),
      });
    }

    // An operator wrote it before this start: adopt it as an operator
    // engagement. Normalised on disk by `resume`, keeping the operator's own
    // fields beside the runner's three.
    this.#carried = Object.fromEntries(
      Object.entries(saved).filter(([key]) => !OWN_FIELDS.has(key)),
    );
    this.#persisted = false;

    return Object.freeze({
      engagedAt: new Date(this.#now()).toISOString(),
      source: 'operator',
      reason: maskOutbound(reasonIn(saved)),
    });
  }

  async #sweepGuarded(engagement: Engagement): Promise<void> {
    try {
      await this.#runSweep(engagement);
    } catch (error) {
      // The latch is down regardless; the barrier holds. What failed is the
      // cleanup, and the next start's `resume` tries it again. The code and not
      // the message: the portfolio read is a broker call, and its message is
      // the server's prose.
      this.#reporter.report(
        'error',
        'the cancel sweep failed',
        error instanceof DomainError
          ? { code: error.code }
          : { error: error instanceof Error ? error.name : 'unknown' },
      );
    }
  }

  async #runSweep(engagement: Engagement): Promise<void> {
    // An order that was mid-submission when the latch came down has to be in
    // the snapshot this reads, or the sweep misses it — up to the cap; see
    // `SWEEP_IDLE_WAIT_MS`. If the cap won, the sweep runs once more when the
    // in-flight submissions do settle: whatever they placed after this read is
    // caught then rather than left resting.
    let idle = false;
    const settled = this.#gateway.idle().then(() => {
      idle = true;
    });

    await Promise.race([settled, this.#wait(SWEEP_IDLE_WAIT_MS)]);

    if (!idle) {
      void settled.then(() => this.#sweepGuarded(engagement));
    }

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
