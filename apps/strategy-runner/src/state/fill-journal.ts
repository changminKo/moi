import type { PositionCost } from '@moi/trading-core';
import {
  assertExactMoney,
  type DecimalString,
  DomainError,
  type Market,
  moneyDecimal,
  type Quantity,
  type Side,
} from '@moi/trading-core';
import { AppendLog, type LogRecord, readAppendLog } from './append-log.js';

/**
 * The account-event cursor of design §6.4, and everything that has to move with
 * it.
 *
 * ## What "the same transaction" means here
 *
 * §6.4 requires the event processing and the cursor advance to be recorded in
 * one transaction, because that is what makes `onFill` exactly-once: a cursor
 * that advances without the fill loses an order the strategy meant to place, and
 * a fill recorded without the cursor places it twice.
 *
 * There is no transaction manager on this substrate — §8.1 chose append-only
 * NDJSON over `node:sqlite` deliberately. So the transaction is **the line**.
 * One event's whole outcome goes into a single record: the fills it announced,
 * the position each of them moved, the realised PnL each of them realised, the
 * ids of the decisions `onFill` returned, and the new cursor value. It is
 * written with one `write` and one `fsync`, and `readAppendLog` discards a
 * trailing record whose bytes did not all land. A reader therefore sees the
 * step whole or sees no trace of it, which is the entire content of atomicity
 * for this purpose.
 *
 * Everything that could have been a second file is in the line for that reason.
 * A `cursor.json` beside the journal — which §8.1 does list — is a second copy
 * of a fact the journal already holds, and after a crash the two can disagree
 * about whether an event was processed; there is nothing to reconcile when
 * there is nothing second. The same argument puts the positions here rather
 * than in `runtime.json`: a position cell one fill ahead of the cursor would
 * have a replay apply a fill to a position that already had it.
 *
 * ## Where the boundary of "exactly once" actually falls
 *
 * The runner cannot make a *crash mid-step* invisible; nothing can. What it
 * makes invisible is the difference:
 *
 * - A step that committed will never run again. The event's `eventId` and every
 *   `fillId` in it are indexed here, and the cursor has moved past it, so
 *   neither a stream replay nor a restart re-delivers it.
 * - A step that did not commit runs again, and produces the same result,
 *   because the decisions `onFill` returns are recorded under ids derived from
 *   `(accountSequence, strategy, index)` rather than from a fresh UUID. The
 *   second run recomputes the same `decisionId`, `StateStore.appendDecision`
 *   recognises it, and the gateway submits it under the same idempotency
 *   key — which the ledger scopes by `(session_id, key)` and answers by
 *   replaying the original order.
 *
 * So `onFill` is invoked at most once per committed step and at least once per
 * event, and the two coincide except across a crash inside one step, where the
 * repeat is unobservable in the ledger. That is the strongest statement this
 * substrate supports, and it is the one the phase's acceptance criterion —
 * no duplicate order, no lost fill — actually asks for.
 *
 * ## What is not solved
 *
 * The journal does not rotate, and startup folds all of it. The same limitation
 * `StateStore` records for the decision log, and the same answer: rotation needs
 * a retention rule an operator agrees to.
 */

export interface CommittedFill {
  readonly fillId: string;
  readonly orderId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly price: DecimalString;
  readonly fee: DecimalString;
  /**
   * What this fill realised, straight out of `applyFillToPosition` — the
   * ledger's own accounting, not a second one derived beside it (AGENTS.md
   * rule 5). Zero on a `BUY`, which realises nothing.
   */
  readonly realizedDelta: DecimalString;
}

export interface FillCommit {
  /** The ledger's cursor for the event this record commits. */
  readonly accountSequence: string;
  /** The runner's clock, ISO. What `realizedPnlOn` buckets by. */
  readonly at: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly fills: readonly CommittedFill[];
  /** Every position the fills moved, after they were applied. Keyed `MARKET:SYMBOL`. */
  readonly positions: Readonly<Record<string, PositionCost>>;
  /** The decisions `onFill` returned. Already durable in `decisions.ndjson`. */
  readonly decisions: readonly string[];
  /** Present when this commit adopted a cursor the stream could not replay to. */
  readonly resync?: string;
}

function invalid(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/u;
const SIGNED_WHOLE = /^-?(?:0|[1-9][0-9]*)$/u;

function readText(source: LogRecord, field: string, where: string): string {
  const value = source[field];

  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${where} is missing ${field}`);
  }

  return value;
}

function readSequence(value: unknown, where: string): string {
  if (typeof value !== 'string' || !WHOLE_NUMBER.test(value)) {
    invalid(`${where} accountSequence must be a whole number`);
  }

  return value;
}

function readQuantity(value: unknown, where: string): Quantity {
  if (typeof value !== 'string' || !SIGNED_WHOLE.test(value)) {
    invalid(`${where} must be a whole number in plain decimal form`);
  }

  return value;
}

function readMoney(value: unknown, where: string): DecimalString {
  if (typeof value !== 'string') {
    invalid(`${where} must be a decimal string`);
  }

  try {
    assertExactMoney(moneyDecimal(value), where);
  } catch {
    invalid(`${where} is not exact money`);
  }

  return value;
}

function readMarket(value: unknown, where: string): Market {
  if (value !== 'KR' && value !== 'US') {
    invalid(`${where} market must be KR or US`);
  }

  return value;
}

function readSide(value: unknown, where: string): Side {
  if (value !== 'BUY' && value !== 'SELL') {
    invalid(`${where} side must be BUY or SELL`);
  }

  return value;
}

function readPosition(value: unknown, where: string): PositionCost {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${where} must be an object`);
  }

  const source = value as LogRecord;

  return Object.freeze({
    symbol: readText(source, 'symbol', where),
    quantity: readQuantity(source.quantity, `${where} quantity`),
    totalCost: readMoney(source.totalCost, `${where} totalCost`),
    realizedPnl: readMoney(source.realizedPnl, `${where} realizedPnl`),
  });
}

function readFill(value: unknown, where: string): CommittedFill {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${where} must be an object`);
  }

  const source = value as LogRecord;

  return Object.freeze({
    fillId: readText(source, 'fillId', where),
    orderId: readText(source, 'orderId', where),
    market: readMarket(source.market, where),
    symbol: readText(source, 'symbol', where),
    side: readSide(source.side, where),
    quantity: readQuantity(source.quantity, `${where} quantity`),
    price: readMoney(source.price, `${where} price`),
    fee: readMoney(source.fee, `${where} fee`),
    realizedDelta: readMoney(source.realizedDelta, `${where} realizedDelta`),
  });
}

/** A commit read back from the journal. It is a file, so it is untrusted. */
export function readFillCommit(source: LogRecord): FillCommit {
  const where = 'a fill commit';
  const positions = source.positions ?? {};

  if (
    typeof positions !== 'object' ||
    positions === null ||
    Array.isArray(positions)
  ) {
    invalid(`${where} positions must be an object`);
  }

  const decisions = source.decisions ?? [];

  if (
    !Array.isArray(decisions) ||
    decisions.some((each) => typeof each !== 'string')
  ) {
    invalid(`${where} decisions must be an array of ids`);
  }

  const fills = source.fills ?? [];

  if (!Array.isArray(fills)) {
    invalid(`${where} fills must be an array`);
  }

  const resync = source.resync;

  if (resync !== undefined && typeof resync !== 'string') {
    invalid(`${where} resync must be a reason`);
  }

  return Object.freeze({
    accountSequence: readSequence(source.accountSequence, where),
    at: readText(source, 'at', where),
    eventId: readText(source, 'eventId', where),
    eventType: readText(source, 'eventType', where),
    fills: Object.freeze(
      fills.map((each, index) => readFill(each, `${where} fill ${index}`)),
    ),
    positions: Object.freeze(
      Object.fromEntries(
        Object.entries(positions as Record<string, unknown>).map(
          ([key, each]) => [
            key,
            readPosition(each, `${where} position ${key}`),
          ],
        ),
      ),
    ),
    decisions: Object.freeze([...(decisions as string[])]),
    ...(resync === undefined ? {} : { resync }),
  });
}

/** The UTC calendar day an instant falls in, as `StateStore.utcDay` does it. */
const utcDay = (instant: string): string => instant.slice(0, 10);

export class FillJournal {
  readonly #log: AppendLog;
  readonly #commits: FillCommit[];
  readonly #events = new Set<string>();
  readonly #fills = new Set<string>();
  readonly #positions = new Map<string, PositionCost>();
  #cursor: string | null = null;
  #resynced = false;

  private constructor(path: string) {
    this.#commits = readAppendLog(path).map(readFillCommit);

    for (const record of this.#commits) {
      this.#index(record);
    }

    this.#log = AppendLog.open(path);
  }

  static open(path: string): FillJournal {
    return new FillJournal(path);
  }

  /** The highest committed sequence, or `null` when nothing has been. */
  get cursor(): string | null {
    return this.#cursor;
  }

  /** True once a commit has adopted a cursor over events never delivered. */
  get resynced(): boolean {
    return this.#resynced;
  }

  hasEvent(eventId: string): boolean {
    return this.#events.has(eventId);
  }

  hasFill(fillId: string): boolean {
    return this.#fills.has(fillId);
  }

  /** The position as of the highest commit that named it. */
  position(key: string): PositionCost | null {
    return this.#positions.get(key) ?? null;
  }

  /** Every position the journal has an opinion about. */
  positions(): ReadonlyMap<string, PositionCost> {
    return this.#positions;
  }

  realizedPnl(): DecimalString {
    return this.#sum(this.#commits);
  }

  realizedPnlOn(day: string): DecimalString {
    return this.#sum(this.#commits.filter((each) => utcDay(each.at) === day));
  }

  /**
   * Closing fills that lost, counted back from the newest until one did not.
   *
   * A `BUY` realises nothing, so it is skipped rather than counted or treated
   * as a break in the run: whether an entry arrived as one fill or three is an
   * accident of the book, and a limit that changed with it would be a limit on
   * liquidity rather than on losing.
   */
  consecutiveLosses(): number {
    let run = 0;

    for (const record of [...this.#commits].reverse()) {
      for (const fill of [...record.fills].reverse()) {
        if (fill.side !== 'SELL') {
          continue;
        }

        if (!moneyDecimal(fill.realizedDelta).isNegative()) {
          return run;
        }

        run += 1;
      }
    }

    return run;
  }

  /**
   * One event's whole outcome, as one durable record. Refuses a sequence that
   * does not advance: a commit that repeated or went backwards would mean the
   * caller processed an event the cursor had already passed, and writing it
   * down would put the journal's own ordering in doubt.
   */
  commit(record: FillCommit): void {
    if (
      this.#cursor !== null &&
      BigInt(record.accountSequence) <= BigInt(this.#cursor)
    ) {
      invalid(
        `a fill commit must advance the cursor: ${record.accountSequence} is not past ${this.#cursor}`,
      );
    }

    // Read back through the same reader the file goes through, before it is
    // written: a record this process cannot parse is one a restart would fail
    // closed on, and failing here names the caller instead.
    const validated = readFillCommit(toRecord(record));

    this.#log.append(toRecord(validated), { durable: true });
    this.#commits.push(validated);
    this.#index(validated);
  }

  close(): void {
    this.#log.close();
  }

  #index(record: FillCommit): void {
    this.#events.add(record.eventId);

    for (const fill of record.fills) {
      this.#fills.add(fill.fillId);
    }

    for (const [key, position] of Object.entries(record.positions)) {
      this.#positions.set(key, position);
    }

    if (record.resync !== undefined) {
      this.#resynced = true;
    }

    if (
      this.#cursor === null ||
      BigInt(record.accountSequence) > BigInt(this.#cursor)
    ) {
      this.#cursor = record.accountSequence;
    }
  }

  #sum(records: readonly FillCommit[]): DecimalString {
    const total = records
      .flatMap((record) => record.fills)
      .reduce((sum, fill) => sum.plus(fill.realizedDelta), moneyDecimal(0));

    return assertExactMoney(total, 'realised PnL').toString();
  }
}

/** Drops the `undefined` fields `exactOptionalPropertyTypes` allows. */
function toRecord(value: object): LogRecord {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );
}
