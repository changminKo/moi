import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tick } from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecordingReporter } from '../reporter.js';
import { openTickRecorder, readTickLog } from './tick-log.js';

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'moi-tick-log-'));
  path = join(directory, 'ticks.ndjson');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const tick = (index: number, price: string): Tick => ({
  market: 'KR',
  symbol: '005930',
  price,
  priceSource: 'rest-snapshot',
  bestBid: '69990',
  bestAsk: '70010',
  asOf: `2026-08-31T00:00:${String(index).padStart(2, '0')}.000Z`,
  marketDataVersion: String(index + 1),
  gapBefore: index === 0,
});

describe('the tick log', () => {
  it('reads back exactly the ticks that were recorded, in order', () => {
    const recorder = openTickRecorder({
      path,
      reporter: createRecordingReporter(),
    });
    const recorded = [tick(0, '70000'), tick(1, '70250'), tick(2, '70500')];

    for (const each of recorded) {
      recorder.record(each);
    }

    recorder.close();

    expect(readTickLog(path)).toStrictEqual(recorded);
  });

  it('reads a null touch back as null rather than as a missing field', () => {
    const recorder = openTickRecorder({
      path,
      reporter: createRecordingReporter(),
    });

    recorder.record({ ...tick(0, '70000'), bestBid: null, bestAsk: null });
    recorder.close();

    expect(readTickLog(path)[0]).toMatchObject({
      bestBid: null,
      bestAsk: null,
    });
  });

  it('is an empty series when nothing was ever recorded', () => {
    expect(readTickLog(join(directory, 'absent.ndjson'))).toStrictEqual([]);
  });

  it('fails closed on a line that is not a tick', () => {
    writeFileSync(path, `${JSON.stringify({ market: 'KR' })}\n`, 'utf8');

    expect(() => readTickLog(path)).toThrow(DomainError);
  });

  it('fails closed on a price that is not exact money', () => {
    writeFileSync(path, `${JSON.stringify({ ...tick(0, '7e4') })}\n`, 'utf8');

    expect(() => readTickLog(path)).toThrow(DomainError);
  });

  /**
   * `AppendLog.append` throws once a record has been left half-written, and it
   * keeps throwing after that by design. A tick log is an input to a later
   * backtest, not a step in the idempotency argument, so the run must survive
   * losing it: the recorder reports once and then stops trying.
   */
  it('reports a failed append once and stops recording rather than failing the run', () => {
    const reporter = createRecordingReporter();
    const recorder = openTickRecorder({ path, reporter });

    recorder.record(tick(0, '70000'));
    recorder.close();

    // Appending after close is exactly the fail-closed refusal `AppendLog`
    // raises for an incomplete record, and the recorder must absorb it the
    // same way.
    expect(() => {
      recorder.record(tick(1, '70250'));
    }).not.toThrow();
    expect(() => {
      recorder.record(tick(2, '70500'));
    }).not.toThrow();

    expect(
      reporter.lines.filter((line) => line.includes('tick log')),
    ).toHaveLength(1);
    expect(readTickLog(path)).toHaveLength(1);
    expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(2);
  });
});
