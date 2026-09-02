import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OrderIntent } from '@moi/strategy-sdk/strategy';
import { readOrderIntent } from '@moi/strategy-sdk/strategy';
import {
  assertExactMoney,
  type DecimalString,
  DomainError,
  moneyDecimal,
} from '@moi/trading-core';
import { AppendLog, type LogRecord, readAppendLog } from './append-log.js';
import { FillJournal } from './fill-journal.js';
import { JsonCell } from './json-cell.js';

/**
 * The runner's durable state (design §3, §8.1), and the whole of what a restart
 * reads.
 *
 * Two kinds of thing live here and they are stored differently on purpose.
 *
 * **Events** — a decision was taken, a submission had an outcome — go to
 * append-only NDJSON. They are facts about the past, an audit record should only
 * grow, and the ordering an append log gives is what the idempotency argument
 * needs: a decision is on disk before the order it authorises is submitted.
 *
 * **Current values** — the session, the feed cursors, each strategy's own
 * snapshot — go to `JsonCell`, replaced atomically. Nobody wants the history of
 * a cursor, and appending one would make "current" a fold over a file that grows
 * for the life of the deployment.
 *
 * ## The index is in memory, and that is the point
 *
 * §8.1 asks for "append-only NDJSON + an in-memory index on restart", and this
 * builds exactly that: the logs are read once at `open` and folded into the two
 * questions the runner asks — which decisions have no outcome yet, and how much
 * notional today has already committed. An on-disk index would be a second copy
 * of a fact the log already holds, and a second copy is a thing that can
 * disagree with the first after a crash. There is nothing to keep in agreement
 * here because there is nothing second.
 *
 * ## What is not solved
 *
 * The logs do not rotate. At one decision per tick and one tick per second a
 * day is roughly 17 MB, and startup reads all of it. That is comfortable for a
 * single-instrument bot and it is not a design that scales to a year. Rotation
 * needs a retention rule an operator agrees to, and it belongs with the
 * deployment work in phase D rather than being invented here.
 */

const DECISIONS = 'decisions.ndjson';
const SUBMISSIONS = 'submissions.ndjson';
const FILLS = 'fills.ndjson';
const SESSION = 'session.json';
const RUNTIME = 'runtime.json';
const KILL_SWITCH = 'kill-switch.json';
/** The latch file's name, exported so an operator document and a test agree on it. */
export const KILL_SWITCH_FILE = KILL_SWITCH;

/**
 * What a line in `decisions.ndjson` records. Only `place` and `cancel`
 * authorise anything; `noop` and `refused` are there because "the strategy
 * stood still" and "the gate said no" are the log's other job, and a decision
 * log that holds only the orders is not a record of what the bot decided.
 */
export type DecisionKind = 'place' | 'cancel';

const ACTIONABLE: ReadonlySet<unknown> = new Set(['place', 'cancel']);

export interface DecisionRecord {
  readonly decisionId: string;
  /** The runner's clock when the decision was taken, ISO. */
  readonly at: string;
  /** The configured strategy instance name, not the strategy id. */
  readonly strategy: string;
  readonly kind: DecisionKind;
  readonly reason: string;
  /** Present on `place`. The intent exactly as the strategy returned it. */
  readonly intent?: OrderIntent;
  /** Present on `cancel`. */
  readonly orderId?: string;
  /**
   * What the order was worth when the decision was taken, in exact money.
   *
   * Recorded on **both** sides. It is a fact about the order — an operator
   * reviewing an exit wants to know what it was worth just as much as an
   * entry — and recording it here means any daily total can be rebuilt from the
   * log alone, without re-reading a market that has since moved.
   *
   * It is deliberately *not* "the amount charged against the daily limit".
   * Which decisions a limit governs is policy, and policy belongs in the query
   * that applies it (`dailyEntryNotional`) rather than in the field, so that a
   * second limit measuring something else can read the same records instead of
   * needing a second field written a second way. Phase C's realised-PnL and
   * loss limits are exactly that second reader: **record the fact, filter in
   * the query.**
   */
  readonly notional?: DecimalString;
}

/**
 * `halted` is the kill switch's outcome (phase D): the barrier refused to submit
 * a decision that was already on disk. It settles the decision — see
 * `pendingDecisions` — because a decision the kill switch caught is a dead
 * decision, not a deferred one.
 */
export type SubmissionOutcome = 'accepted' | 'rejected' | 'halted';

export interface SubmissionRecord {
  readonly decisionId: string;
  readonly at: string;
  readonly outcome: SubmissionOutcome;
  readonly orderId?: string;
  readonly status?: string;
  /** The domain error code, on a rejection. Never a message with a secret in it. */
  readonly code?: string;
  /**
   * On a `halted` outcome: how many attempts had gone out before the barrier
   * caught it. Zero means the order never left the process; one or more means
   * the ledger may hold it, which `dailyEntryNotional` has to assume it does.
   */
  readonly attempts?: number;
}

function invalid(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function readText(source: LogRecord, field: string, where: string): string {
  const value = source[field];

  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${where} is missing ${field}`);
  }

  return value;
}

function readOptionalText(
  source: LogRecord,
  field: string,
  where: string,
): string | undefined {
  return source[field] === undefined
    ? undefined
    : readText(source, field, where);
}

/** A decision read back from the log. It is a file, so it is untrusted. */
export function readDecisionRecord(source: LogRecord): DecisionRecord {
  const where = 'a decision record';
  const kind = source.kind;

  if (kind !== 'place' && kind !== 'cancel') {
    invalid(`${where} must be a place or a cancel`);
  }

  const base = {
    decisionId: readText(source, 'decisionId', where),
    at: readText(source, 'at', where),
    strategy: readText(source, 'strategy', where),
    kind: kind as DecisionKind,
    reason: readText(source, 'reason', where),
    ...(source.notional === undefined
      ? {}
      : { notional: readMoney(source.notional, `${where} notional`) }),
  };

  if (kind === 'cancel') {
    return Object.freeze({
      ...base,
      orderId: readText(source, 'orderId', where),
    });
  }

  // Validated through the SDK's own reader rather than a local copy: the intent
  // that comes back out of the log has to be the same shape the gateway is
  // allowed to promote, and `readOrderIntent` is where that shape is decided.
  return Object.freeze({ ...base, intent: readOrderIntent(source.intent) });
}

export function readSubmissionRecord(source: LogRecord): SubmissionRecord {
  const where = 'a submission record';
  const outcome = source.outcome;

  if (
    outcome !== 'accepted' &&
    outcome !== 'rejected' &&
    outcome !== 'halted'
  ) {
    invalid(`${where} must be accepted, rejected or halted`);
  }

  const orderId = readOptionalText(source, 'orderId', where);
  const status = readOptionalText(source, 'status', where);
  const code = readOptionalText(source, 'code', where);
  const attempts = source.attempts;

  if (
    attempts !== undefined &&
    (typeof attempts !== 'number' ||
      !Number.isInteger(attempts) ||
      attempts < 0)
  ) {
    invalid(`${where} has a malformed attempts count`);
  }

  return Object.freeze({
    decisionId: readText(source, 'decisionId', where),
    at: readText(source, 'at', where),
    outcome,
    ...(orderId === undefined ? {} : { orderId }),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(attempts === undefined ? {} : { attempts: attempts as number }),
  });
}

function readMoney(value: unknown, description: string): DecimalString {
  if (typeof value !== 'string') {
    invalid(`${description} must be a decimal string`);
  }

  try {
    assertExactMoney(moneyDecimal(value), description);
  } catch {
    invalid(`${description} is not exact money`);
  }

  return value;
}

/** The UTC calendar day a recorded instant falls in. See `dailyEntryNotional`. */
export const utcDay = (instant: string): string => instant.slice(0, 10);

export interface StateStoreOptions {
  readonly directory: string;
}

export class StateStore {
  readonly #decisions: AppendLog;
  readonly #submissions: AppendLog;
  readonly #decided: DecisionRecord[];
  readonly #settled: Set<string>;
  /**
   * The subset of `#settled` the kill switch settled (`halted`) **before any
   * attempt went out**. Kept apart because `dailyEntryNotional` has to leave
   * these out: such a decision is exactly one the runner never submitted. A
   * halt after an attempt stays counted — the ledger may hold that order.
   */
  readonly #halted: Set<string>;
  readonly #recorded = new Set<string>();
  /**
   * The account-event cursor and everything that commits with it (§6.4). Its
   * own file because its unit of atomicity is one *event*, not one decision:
   * see `FillJournal` for what "the same transaction" means on this substrate.
   */
  readonly fills: FillJournal;
  readonly session: JsonCell;
  readonly runtime: JsonCell;
  /**
   * The kill switch's latch (phase D). Present means engaged; absent means not.
   * An operator clears it by deleting the file and restarting — so it is a
   * cell, not a log line: there is no history to keep, only a current fact.
   */
  readonly killSwitch: JsonCell;

  private constructor(directory: string) {
    mkdirSync(directory, { recursive: true });

    this.#decided = readAppendLog(join(directory, DECISIONS))
      // Past the `noop` and `refused` lines, which are audit and not
      // instruction. An unrecognised `kind` still fails closed inside
      // `readDecisionRecord`, so this filters by what the log means rather than
      // tolerating whatever it happens to hold.
      .filter((record) => ACTIONABLE.has(record.kind))
      .map(readDecisionRecord);
    const submissions = readAppendLog(join(directory, SUBMISSIONS)).map(
      readSubmissionRecord,
    );

    this.#settled = new Set(submissions.map((record) => record.decisionId));
    this.#halted = new Set(
      submissions.filter(neverSent).map((record) => record.decisionId),
    );
    for (const record of this.#decided) {
      this.#recorded.add(record.decisionId);
    }

    this.#decisions = AppendLog.open(join(directory, DECISIONS));
    this.#submissions = AppendLog.open(join(directory, SUBMISSIONS));
    this.fills = FillJournal.open(join(directory, FILLS));
    this.session = new JsonCell(join(directory, SESSION), { mode: 0o600 });
    this.runtime = new JsonCell(join(directory, RUNTIME));
    this.killSwitch = new JsonCell(join(directory, KILL_SWITCH));
  }

  static open(options: StateStoreOptions): StateStore {
    return new StateStore(options.directory);
  }

  /**
   * Records a decision **durably**, before anything is submitted under it. This
   * is step 1 of design §6.2 and the reason the fsync is not optional: after
   * this returns, a crash leaves a decision whose idempotency key a restart can
   * recompute, and before it returns, a crash leaves nothing at all. There is no
   * window in which an order exists that the state does not know about.
   */
  /**
   * Idempotent by `decisionId`, and that is what makes an uncommitted fill step
   * safe to replay (§6.4). A decision derived from an account event takes an id
   * derived from that event, so re-running `onFill` after a crash recomputes the
   * *same* id; writing the line twice would put one order in `dailyEntryNotional`
   * twice and leave two log lines an operator has to recognise as one decision.
   *
   * Answers whether it wrote, so a caller can tell a fresh decision from a
   * replayed one. A repeat is not an error: it is the expected shape of a
   * recovery, and treating it as one would make the replay path throw on the
   * very case it exists for.
   */
  appendDecision(record: DecisionRecord): boolean {
    if (this.#recorded.has(record.decisionId)) {
      return false;
    }

    this.#decisions.append(toRecord(record), { durable: true });
    this.#decided.push(Object.freeze(record));
    this.#recorded.add(record.decisionId);

    return true;
  }

  appendSubmission(record: SubmissionRecord): void {
    this.#submissions.append(toRecord(record), { durable: true });
    this.#settled.add(record.decisionId);

    if (neverSent(record)) {
      this.#halted.add(record.decisionId);
    }
  }

  /**
   * A `noop` never reaches the decision log's durable path — it authorises
   * nothing, so nothing waits on it being on disk — but it is still written,
   * because "the strategy stood still and here is why" is the log's other job.
   */
  appendNoop(record: {
    readonly at: string;
    readonly strategy: string;
    readonly reason: string;
  }): void {
    this.#decisions.append({ kind: 'noop', ...record });
  }

  /**
   * An order the strategy wanted and the risk gate refused. Recorded as its own
   * kind rather than as a `noop`: "nothing to do" and "I was stopped" are
   * different facts, and an operator tuning a limit needs to find the second.
   * Like a `noop` it authorises nothing, so it is not pending and not fsynced.
   */
  appendRefusal(record: {
    readonly at: string;
    readonly strategy: string;
    /** The strategy's own reason for wanting the order. */
    readonly reason: string;
    /** The gate's reason for refusing it. */
    readonly refusal: string;
  }): void {
    this.#decisions.append({ kind: 'refused', ...record });
  }

  /**
   * Decisions that were recorded and never got an outcome — the ones a restart
   * has to finish. A crash between the append and the submission leaves exactly
   * these, and each is resubmitted under the key its own `decisionId` derives.
   */
  pendingDecisions(): readonly DecisionRecord[] {
    return Object.freeze(
      this.#decided.filter((record) => !this.#settled.has(record.decisionId)),
    );
  }

  /**
   * How much **entry** notional has been committed on a UTC day, over every
   * decision that recorded one — pending included, because a decision that has
   * been written down is a decision the runner is going to submit. The one
   * exception is a decision settled as `halted` **with no attempt made**: the
   * kill switch caught it before it left, and charging it would leave an
   * operator who clears the latch the same day short of budget for orders that
   * never went out. A halt after an attempt is still charged — that request may
   * have reached the ledger.
   *
   * Entries only, and the name says so rather than leaving it to be discovered.
   * `RiskGate` applies the daily limit to a `BUY` and never to a `SELL`, because
   * a limit that refuses an exit does not cap exposure, it traps it. Counting
   * both sides charged a round trip twice against a budget only one side can
   * spend: enter at the limit, exit the whole position, and the day's remaining
   * re-entries are refused on a budget that was never used. It failed in the
   * safe direction and it still locked the bot out for the rest of the day.
   *
   * UTC rather than market-local: a market-local day needs a calendar the runner
   * does not own, and a bot trading two markets would have two days at once. The
   * limit is a rate limit on the runner's own activity, so the runner's own
   * clock is the honest boundary. Stated here because phase C's realised-PnL
   * accounting will have to answer the same question and should answer it the
   * same way.
   */
  dailyEntryNotional(day: string): DecimalString {
    const total = this.#decided
      .filter(
        (record) =>
          record.notional !== undefined &&
          // A cancel carries no intent and commits nothing; a sell is an exit.
          record.intent?.side === 'BUY' &&
          !this.#halted.has(record.decisionId) &&
          utcDay(record.at) === day,
      )
      .reduce(
        (sum, record) => sum.plus(record.notional as DecimalString),
        moneyDecimal(0),
      );

    return assertExactMoney(total, 'daily entry notional').toString();
  }

  close(): void {
    this.#decisions.close();
    this.#submissions.close();
    this.fills.close();
  }
}

/** A halted submission that never left the process. */
const neverSent = (record: SubmissionRecord): boolean =>
  record.outcome === 'halted' && record.attempts === 0;

/** Drops the `undefined` fields `exactOptionalPropertyTypes` allows. */
function toRecord(value: object): LogRecord {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );
}
