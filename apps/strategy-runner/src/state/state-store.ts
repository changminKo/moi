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
const SESSION = 'session.json';
const RUNTIME = 'runtime.json';

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
   * The tick price the decision was taken at, and the notional the risk gate
   * measured. Recorded so the daily total can be rebuilt from the log alone,
   * without re-reading a market that has since moved.
   */
  readonly notional?: DecimalString;
}

export type SubmissionOutcome = 'accepted' | 'rejected';

export interface SubmissionRecord {
  readonly decisionId: string;
  readonly at: string;
  readonly outcome: SubmissionOutcome;
  readonly orderId?: string;
  readonly status?: string;
  /** The domain error code, on a rejection. Never a message with a secret in it. */
  readonly code?: string;
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

  if (outcome !== 'accepted' && outcome !== 'rejected') {
    invalid(`${where} must be accepted or rejected`);
  }

  const orderId = readOptionalText(source, 'orderId', where);
  const status = readOptionalText(source, 'status', where);
  const code = readOptionalText(source, 'code', where);

  return Object.freeze({
    decisionId: readText(source, 'decisionId', where),
    at: readText(source, 'at', where),
    outcome,
    ...(orderId === undefined ? {} : { orderId }),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
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

/** The UTC calendar day a recorded instant falls in. See `dailyNotional`. */
export const utcDay = (instant: string): string => instant.slice(0, 10);

export interface StateStoreOptions {
  readonly directory: string;
}

export class StateStore {
  readonly #decisions: AppendLog;
  readonly #submissions: AppendLog;
  readonly #decided: DecisionRecord[];
  readonly #settled: Set<string>;
  readonly session: JsonCell;
  readonly runtime: JsonCell;

  private constructor(directory: string) {
    mkdirSync(directory, { recursive: true });

    this.#decided = readAppendLog(join(directory, DECISIONS))
      // Past the `noop` and `refused` lines, which are audit and not
      // instruction. An unrecognised `kind` still fails closed inside
      // `readDecisionRecord`, so this filters by what the log means rather than
      // tolerating whatever it happens to hold.
      .filter((record) => ACTIONABLE.has(record.kind))
      .map(readDecisionRecord);
    this.#settled = new Set(
      readAppendLog(join(directory, SUBMISSIONS))
        .map(readSubmissionRecord)
        .map((record) => record.decisionId),
    );
    this.#decisions = AppendLog.open(join(directory, DECISIONS));
    this.#submissions = AppendLog.open(join(directory, SUBMISSIONS));
    this.session = new JsonCell(join(directory, SESSION), { mode: 0o600 });
    this.runtime = new JsonCell(join(directory, RUNTIME));
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
  appendDecision(record: DecisionRecord): void {
    this.#decisions.append(toRecord(record), { durable: true });
    this.#decided.push(Object.freeze(record));
  }

  appendSubmission(record: SubmissionRecord): void {
    this.#submissions.append(toRecord(record), { durable: true });
    this.#settled.add(record.decisionId);
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
   * How much notional has been committed on a UTC day, over every decision that
   * recorded one — pending included, because a decision that has been written
   * down is a decision the runner is going to submit.
   *
   * UTC rather than market-local: a market-local day needs a calendar the runner
   * does not own, and a bot trading two markets would have two days at once. The
   * limit it enforces is a rate limit on the runner's own activity, so the
   * runner's own clock is the honest boundary. Stated here because phase C's
   * realised-PnL accounting will have to answer the same question and should
   * answer it the same way.
   */
  dailyNotional(day: string): DecimalString {
    const total = this.#decided
      .filter(
        (record) => record.notional !== undefined && utcDay(record.at) === day,
      )
      .reduce(
        (sum, record) => sum.plus(record.notional as DecimalString),
        moneyDecimal(0),
      );

    return assertExactMoney(total, 'daily notional').toString();
  }

  close(): void {
    this.#decisions.close();
    this.#submissions.close();
  }
}

/** Drops the `undefined` fields `exactOptionalPropertyTypes` allows. */
function toRecord(value: object): LogRecord {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );
}
