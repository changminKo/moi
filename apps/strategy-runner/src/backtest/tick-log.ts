import type { Tick, TickPriceSource } from '@moi/strategy-sdk/strategy';
import {
  type DecimalString,
  DomainError,
  type Market,
  readExactMoney,
} from '@moi/trading-core';
import type { Reporter } from '../reporter.js';
import {
  AppendLog,
  type LogRecord,
  readAppendLog,
} from '../state/append-log.js';

/**
 * The recorded tick series — the input side of design §8.2, and the only input
 * a backtest has. §8.4 is explicit that there is no historical candle API, so a
 * replay can only be as good as what a run wrote down.
 *
 * It is the same NDJSON append log the decision and submission logs use, for
 * the ordering and torn-tail properties `append-log.ts` documents, and it is
 * read back through the same validator every other stored record goes through:
 * a tick log is a *file*, and a file that has been sitting on a volume is
 * untrusted input, whoever wrote it.
 *
 * ## Losing it must not stop a run
 *
 * `AppendLog.append` refuses every further append once a record has been left
 * half-written, permanently and by design — appending onto a fragment would
 * splice two records into one unparseable line. For the decision log that is
 * exactly right: the log is a step in the idempotency argument, so a run that
 * cannot write it must stop.
 *
 * A tick log is not that. It is an input to a *later* backtest, nothing waits
 * on it, and a bot that stopped trading because its research artifact could not
 * be written would be failing in the wrong direction. So the recorder catches
 * the refusal, reports it **once**, and stops recording. What is on disk stays
 * readable — the fragment is a torn tail, which `readAppendLog` discards — and
 * the run carries on.
 */

const TICK_PRICE_SOURCES: ReadonlySet<string> = new Set<TickPriceSource>([
  'book-mid',
  'rest-snapshot',
]);
const MARKETS: ReadonlySet<string> = new Set<Market>(['KR', 'US']);
const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/u;

function invalid(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', `a recorded tick ${message}`);
}

function readPrice(value: unknown, field: string): DecimalString {
  if (typeof value !== 'string') {
    invalid(`${field} must be a decimal string`);
  }

  let parsed: ReturnType<typeof readExactMoney>;

  try {
    parsed = readExactMoney(value, 'INVALID_PRICE', field);
  } catch {
    invalid(`${field} is not exact money`);
  }

  if (!parsed.gt(0)) {
    invalid(`${field} must be positive`);
  }

  return value;
}

/** A touch is a price or an explicit `null`; a missing field is corruption. */
function readTouch(source: LogRecord, field: string): DecimalString | null {
  const value = source[field];

  if (value === null) {
    return null;
  }

  if (value === undefined) {
    invalid(`is missing ${field}`);
  }

  return readPrice(value, field);
}

function readText(source: LogRecord, field: string): string {
  const value = source[field];

  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`is missing ${field}`);
  }

  return value;
}

/** One line of the tick log, validated into the SDK's `Tick`. */
export function readTick(source: LogRecord): Tick {
  const market = source.market;
  const priceSource = source.priceSource;
  const marketDataVersion = source.marketDataVersion;
  const gapBefore = source.gapBefore;

  if (typeof market !== 'string' || !MARKETS.has(market)) {
    invalid('market must be KR or US');
  }

  if (typeof priceSource !== 'string' || !TICK_PRICE_SOURCES.has(priceSource)) {
    invalid('priceSource must be book-mid or rest-snapshot');
  }

  if (
    typeof marketDataVersion !== 'string' ||
    !WHOLE_NUMBER.test(marketDataVersion)
  ) {
    invalid('marketDataVersion must be a whole number');
  }

  if (typeof gapBefore !== 'boolean') {
    invalid('gapBefore must be true or false');
  }

  return Object.freeze({
    market: market as Market,
    symbol: readText(source, 'symbol'),
    price: readPrice(source.price, 'price'),
    priceSource: priceSource as TickPriceSource,
    bestBid: readTouch(source, 'bestBid'),
    bestAsk: readTouch(source, 'bestAsk'),
    asOf: readText(source, 'asOf'),
    marketDataVersion,
    gapBefore,
  });
}

export function readTickLog(path: string): readonly Tick[] {
  return Object.freeze(readAppendLog(path).map(readTick));
}

export interface TickRecorderOptions {
  readonly path: string;
  readonly reporter: Reporter;
}

export interface TickRecorder {
  record(tick: Tick): void;
  close(): void;
}

/**
 * Ticks are written without an fsync. Nothing observable waits on one being on
 * disk — that is the whole distinction `append-log.ts` draws for `noop`
 * decisions — and paying an fsync per tick to protect a research artifact would
 * put the cost somewhere the argument does not need it.
 */
export function openTickRecorder(options: TickRecorderOptions): TickRecorder {
  const log = AppendLog.open(options.path);
  let recording = true;

  return {
    record: (tick) => {
      if (!recording) {
        return;
      }

      try {
        // A plain own-data copy: `Tick` is frozen and may be a caller's object,
        // and what is recorded should be the fields this module names rather
        // than whatever else happens to be hanging off it.
        log.append({
          market: tick.market,
          symbol: tick.symbol,
          price: tick.price,
          priceSource: tick.priceSource,
          bestBid: tick.bestBid,
          bestAsk: tick.bestAsk,
          asOf: tick.asOf,
          marketDataVersion: tick.marketDataVersion,
          gapBefore: tick.gapBefore,
        });
      } catch (error) {
        recording = false;
        options.reporter.report(
          'warn',
          'the tick log could not be written and recording has stopped; the run continues',
          {
            path: options.path,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    },
    // Deliberately does not set `recording`: a record after a close should take
    // the same path as a record after a half-written one, because from here
    // they are the same fact — the log refused an append and said why.
    close: () => {
      log.close();
    },
  };
}
