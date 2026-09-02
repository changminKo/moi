import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { StrategyDecision, Tick } from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubmitResult } from '../gateway/order-gateway.js';
import { createRecordingReporter } from '../reporter.js';
import { JsonCell } from '../state/json-cell.js';
import type { DecisionRecord } from '../state/state-store.js';
import {
  HEARTBEAT_MS,
  KillSwitch,
  MAX_SWEEP_PASSES,
  SWEEP_IDLE_WAIT_MS,
} from './kill-switch.js';

const ENGAGED_AT_MS = Date.parse('2026-09-02T02:00:00.000Z');
const ENGAGED_AT = '2026-09-02T02:00:00.000Z';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'moi-kill-switch-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

type PortfolioOrder = BrokerPortfolio['activeOrders'][number];

const order = (id: string, status = 'OPEN'): PortfolioOrder =>
  ({
    id,
    market: 'KR',
    symbol: '005930',
    type: 'LIMIT',
    side: 'BUY',
    quantity: '1',
    filledQuantity: '0',
    status,
    fills: [],
    siblingOrderIds: [],
  }) as unknown as PortfolioOrder;

const portfolioOf = (orders: readonly PortfolioOrder[]): BrokerPortfolio =>
  ({
    sessionId: 's-1',
    wallets: [],
    positions: [],
    activeOrders: orders,
    accountSequence: '1',
  }) as unknown as BrokerPortfolio;

/**
 * A gateway that records what the sweep asked of it. `idle` resolves when the
 * test says so, which is how the ordering "wait, then read" is observed.
 */
function fakeGateway(options: { readonly idle?: Promise<void> } = {}) {
  const recorded: DecisionRecord[] = [];
  const submitted: string[] = [];

  return {
    recorded,
    submitted,
    idle: () => options.idle ?? Promise.resolve(),
    record: (
      strategy: string,
      decision: StrategyDecision,
      _tick: Tick | null,
      recordOptions: { readonly decisionId?: string } = {},
    ): DecisionRecord | null => {
      if (decision.kind !== 'cancel') {
        throw new Error('the sweep only cancels');
      }

      const record: DecisionRecord = {
        decisionId: recordOptions.decisionId ?? 'unexpected',
        at: ENGAGED_AT,
        strategy,
        kind: 'cancel',
        reason: decision.reason,
        orderId: decision.orderId,
      };

      recorded.push(record);

      return record;
    },
    submit: async (record: DecisionRecord): Promise<SubmitResult> => {
      submitted.push(record.decisionId);

      return {
        decisionId: record.decisionId,
        outcome: 'accepted',
        orderId: record.orderId as string,
      };
    },
  };
}

function build(
  options: {
    readonly portfolios?: readonly BrokerPortfolio[];
    readonly gateway?: ReturnType<typeof fakeGateway>;
    readonly nowMs?: () => number;
    readonly cell?: JsonCell;
    /** How the sweep waits out an in-flight submission. Never resolves by default. */
    readonly wait?: (ms: number) => Promise<void>;
  } = {},
) {
  const reporter = createRecordingReporter();
  const gateway = options.gateway ?? fakeGateway();
  const snapshots = [...(options.portfolios ?? [portfolioOf([])])];
  let reads = 0;
  const killSwitch = new KillSwitch({
    cell: options.cell ?? new JsonCell(join(directory, 'kill-switch.json')),
    gateway,
    portfolio: async () => {
      reads += 1;

      return snapshots.length > 1
        ? (snapshots.shift() as BrokerPortfolio)
        : (snapshots[0] as BrokerPortfolio);
    },
    reporter,
    now: options.nowMs ?? (() => ENGAGED_AT_MS),
    wait: options.wait ?? (() => new Promise(() => undefined)),
  });

  return { killSwitch, gateway, reporter, reads: () => reads };
}

/** A cell whose writes fail the way a full or read-only disk fails them. */
function unwritableCell(): JsonCell {
  const cell = new JsonCell(join(directory, 'kill-switch.json'));

  cell.write = () => {
    const error = new Error(
      'ENOSPC: no space left on device',
    ) as NodeJS.ErrnoException;

    error.code = 'ENOSPC';
    throw error;
  };

  return cell;
}

const latch = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(directory, 'kill-switch.json'), 'utf8'),
  ) as Record<string, unknown>;

describe('KillSwitch engagement', () => {
  it('starts disengaged and permits everything', () => {
    const { killSwitch } = build();

    expect(killSwitch.engaged).toBe(false);
    expect(killSwitch.permits('place')).toBe(true);
    expect(killSwitch.permits('cancel')).toBe(true);
  });

  it('writes the latch, reports once, and then refuses places but not cancels', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.engage('operator', 'drill', { by: 'test' });

    expect(latch()).toStrictEqual({
      engagedAt: ENGAGED_AT,
      source: 'operator',
      reason: 'drill',
    });
    expect(killSwitch.permits('place')).toBe(false);
    expect(killSwitch.permits('cancel')).toBe(true);
    expect(
      reporter.lines.filter((line) =>
        line.includes('the kill switch is engaged'),
      ),
    ).toStrictEqual([
      '[error] the kill switch is engaged; new orders are refused and resting orders are being cancelled source=operator reason=drill by=test',
    ]);
  });

  /**
   * The order is the guarantee: a crash between "decided to stop" and "said so"
   * must leave a runner that comes back stopped. Observed from inside the first
   * report, which is the first thing after the write.
   */
  it('has the latch on disk before the first report and before any sweep read', async () => {
    const reporter = createRecordingReporter();
    const path = join(directory, 'kill-switch.json');
    const seen: boolean[] = [];
    const gateway = fakeGateway();
    let reads = 0;
    const killSwitch = new KillSwitch({
      cell: new JsonCell(path),
      gateway,
      portfolio: async () => {
        reads += 1;
        seen.push(existsSync(path));

        return portfolioOf([]);
      },
      reporter: {
        report: (level, message, fields) => {
          seen.push(existsSync(path));
          reporter.report(level, message, fields);
        },
      },
      now: () => ENGAGED_AT_MS,
    });

    await killSwitch.engage('operator', 'drill');

    expect(reads).toBe(1);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every(Boolean)).toBe(true);
  });

  /**
   * Fail closed even when the disk fails: the in-memory barrier closes before
   * the write, a write failure is reported rather than thrown, and persistence
   * is retried on later observations so a restart still comes up engaged.
   */
  it('stays engaged in memory when the latch cannot be written, reports it, and retries', async () => {
    const cell = unwritableCell();
    const { killSwitch, reporter } = build({ cell });

    await expect(
      killSwitch.engage('operator', 'drill'),
    ).resolves.toBeUndefined();

    expect(killSwitch.engaged).toBe(true);
    expect(killSwitch.permits('place')).toBe(false);
    expect(existsSync(join(directory, 'kill-switch.json'))).toBe(false);
    expect(reporter.lines).toContain(
      '[error] the kill switch could not be persisted; it holds in memory but a restart would come up trading code=ENOSPC',
    );

    // The disk comes back: the next observation writes the latch.
    cell.write = JsonCell.prototype.write;
    await killSwitch.observeOperatorFile();

    expect(latch()).toStrictEqual({
      engagedAt: ENGAGED_AT,
      source: 'operator',
      reason: 'drill',
    });
  });

  it('is idempotent: a second engage neither rewrites nor re-reports', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.engage('operator', 'first');

    const before = reporter.lines.length;

    await killSwitch.engage('fill-wedge', 'second');

    expect(killSwitch.engagement?.reason).toBe('first');
    expect(latch().reason).toBe('first');
    expect(reporter.lines.length).toBe(before);
  });

  it('comes up engaged when the latch file already exists', () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({
        engagedAt: '2026-09-01T00:00:00.000Z',
        source: 'loss-limit',
        reason: 'x',
      }),
    );

    const { killSwitch } = build();

    expect(killSwitch.engaged).toBe(true);
    expect(killSwitch.engagement).toStrictEqual({
      engagedAt: '2026-09-01T00:00:00.000Z',
      source: 'loss-limit',
      reason: 'x',
    });
  });
});

describe('KillSwitch operator file', () => {
  it('engages on the next observation when an operator writes the file', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.observeOperatorFile();
    expect(killSwitch.engaged).toBe(false);

    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ reason: 'manual stop' }),
    );
    await killSwitch.observeOperatorFile();

    expect(killSwitch.engaged).toBe(true);
    expect(killSwitch.engagement).toMatchObject({
      source: 'operator',
      reason: 'manual stop',
    });
    expect(latch()).toStrictEqual({
      engagedAt: ENGAGED_AT,
      source: 'operator',
      reason: 'manual stop',
    });
    expect(reporter.lines.join('\n')).toContain(
      'source=operator reason=manual stop',
    );
  });

  /** Fail closed: a kill-switch file the runner cannot read is still a kill-switch file. */
  it('engages on an unreadable or reason-less operator file', async () => {
    const { killSwitch } = build();

    writeFileSync(join(directory, 'kill-switch.json'), 'not json');
    await killSwitch.observeOperatorFile();

    expect(killSwitch.engagement).toMatchObject({
      source: 'operator',
      reason: 'operator file present',
    });

    rmSync(join(directory, 'kill-switch.json'));

    const second = build();

    writeFileSync(join(directory, 'kill-switch.json'), '{}');
    await second.killSwitch.observeOperatorFile();

    expect(second.killSwitch.engagement).toMatchObject({
      source: 'operator',
      reason: 'operator file present',
    });
  });

  /**
   * Construction reads; `resume` writes. A supervisor being *built* must not
   * rewrite an operator's file, and when the file is normalised the operator's
   * own fields (`by`, a ticket) survive beside the runner's three.
   */
  it('adopts an operator file found at construction, and normalises it on resume keeping its fields', async () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ reason: 'written before start', by: 'oncall' }),
    );

    const { killSwitch } = build();

    expect(killSwitch.engagement).toStrictEqual({
      engagedAt: ENGAGED_AT,
      source: 'operator',
      reason: 'written before start',
    });
    expect(latch()).toStrictEqual({
      reason: 'written before start',
      by: 'oncall',
    });

    await killSwitch.resume();

    expect(latch()).toStrictEqual({
      by: 'oncall',
      engagedAt: ENGAGED_AT,
      source: 'operator',
      reason: 'written before start',
    });
  });

  /** A transient read fault is not a kill switch: it is reported and re-read next cycle. */
  it('does not engage on a read fault that is neither absence nor bad JSON', async () => {
    mkdirSync(join(directory, 'kill-switch.json'));

    const { killSwitch, reporter } = build();

    await killSwitch.observeOperatorFile();

    expect(killSwitch.engaged).toBe(false);
    expect(reporter.lines).toStrictEqual([
      '[warn] the kill-switch file could not be read and will be retried next cycle code=EISDIR',
    ]);
  });

  it('masks the reason before it is written to disk', async () => {
    const { killSwitch } = build();

    await killSwitch.engage(
      'fill-wedge',
      'record carried cookie moi_session=abcdef0123456789abcdef0123456789',
    );

    expect(
      readFileSync(join(directory, 'kill-switch.json'), 'utf8'),
    ).not.toContain('abcdef0123456789abcdef0123456789');
  });

  it('stays engaged even if the file disappears while running', async () => {
    const { killSwitch } = build();

    await killSwitch.engage('operator', 'drill');
    rmSync(join(directory, 'kill-switch.json'));
    await killSwitch.observeOperatorFile();

    expect(killSwitch.engaged).toBe(true);
  });
});

describe('KillSwitch cancel sweep', () => {
  it('waits for in-flight submissions before reading the portfolio', async () => {
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = fakeGateway({ idle });
    const { killSwitch, reads } = build({
      gateway,
      portfolios: [portfolioOf([])],
    });

    const engaging = killSwitch.engage('operator', 'drill');

    await Promise.resolve();
    expect(reads()).toBe(0);

    release();
    await engaging;
    expect(reads()).toBe(1);
  });

  it('cancels every open order through the gateway with a deterministic decision id', async () => {
    const gateway = fakeGateway();
    const { killSwitch, reporter } = build({
      gateway,
      portfolios: [
        portfolioOf([
          order('o-1'),
          order('o-2', 'FILLED'),
          order('o-3', 'PARTIALLY_FILLED'),
        ]),
        portfolioOf([order('o-2', 'FILLED')]),
      ],
    });

    await killSwitch.engage(
      'loss-limit',
      '3 closing fills in a row lost, at the limit of 3',
    );

    expect(
      gateway.recorded.map((each) => [
        each.decisionId,
        each.strategy,
        each.orderId,
        each.reason,
      ]),
    ).toStrictEqual([
      [
        `kill:${ENGAGED_AT}:o-1`,
        'kill-switch',
        'o-1',
        'kill switch: 3 closing fills in a row lost, at the limit of 3',
      ],
      [
        `kill:${ENGAGED_AT}:o-3`,
        'kill-switch',
        'o-3',
        'kill switch: 3 closing fills in a row lost, at the limit of 3',
      ],
    ]);
    expect(gateway.submitted).toStrictEqual([
      `kill:${ENGAGED_AT}:o-1`,
      `kill:${ENGAGED_AT}:o-3`,
    ]);
    expect(reporter.lines.at(-1)).toBe(
      '[info] the cancel sweep found no resting orders passes=1',
    );
  });

  it('rescans, so an order that appeared after the first pass is cancelled too', async () => {
    const gateway = fakeGateway();
    const { killSwitch } = build({
      gateway,
      portfolios: [
        portfolioOf([order('o-1')]),
        portfolioOf([order('o-9')]),
        portfolioOf([]),
      ],
    });

    await killSwitch.engage('operator', 'drill');

    expect(gateway.submitted).toStrictEqual([
      `kill:${ENGAGED_AT}:o-1`,
      `kill:${ENGAGED_AT}:o-9`,
    ]);
  });

  it('gives up after the last pass and names what is still resting', async () => {
    const gateway = fakeGateway();
    const { killSwitch, reporter } = build({
      gateway,
      portfolios: [portfolioOf([order('o-stuck')])],
    });

    await killSwitch.engage('operator', 'drill');

    expect(gateway.submitted).toHaveLength(MAX_SWEEP_PASSES);
    expect(reporter.lines.at(-1)).toBe(
      `[error] the cancel sweep left resting orders after its last pass passes=${MAX_SWEEP_PASSES} orderIds=o-stuck`,
    );
  });

  /**
   * A sweep failure is reported by code, never by message: the portfolio read
   * is a broker call and its message is the server's prose.
   */
  it('reports a sweep that throws by its code, not its message, instead of rejecting engage', async () => {
    const gateway = fakeGateway();
    let calls = 0;
    const { killSwitch, reporter } = build({
      gateway,
      portfolios: [portfolioOf([order('o-1')])],
    });

    gateway.submit = async () => {
      calls += 1;
      throw new DomainError(
        'SERVICE_UNAVAILABLE',
        'opaque-sensitive-server-text',
      );
    };

    await expect(
      killSwitch.engage('operator', 'drill'),
    ).resolves.toBeUndefined();
    expect(killSwitch.engaged).toBe(true);
    expect(calls).toBe(1);
    expect(reporter.lines.at(-1)).toBe(
      '[error] the cancel sweep failed code=SERVICE_UNAVAILABLE',
    );
    expect(reporter.lines.join('\n')).not.toContain('opaque-sensitive');
  });

  it('names a non-domain sweep failure by its class only', async () => {
    const gateway = fakeGateway();

    gateway.submit = async () => {
      throw new TypeError('secret-looking detail');
    };

    const { killSwitch, reporter } = build({
      gateway,
      portfolios: [portfolioOf([order('o-1')])],
    });

    await killSwitch.engage('operator', 'drill');

    expect(reporter.lines.at(-1)).toBe(
      '[error] the cancel sweep failed error=TypeError',
    );
  });

  /**
   * `idle()` has no upper bound of its own — a submission in a long backoff
   * holds it — so the sweep waits at most `SWEEP_IDLE_WAIT_MS` and then reads
   * anyway. An order that settles later is caught by the re-scan or by the next
   * start's `resume`; leaving resting orders out for the length of a backoff is
   * the worse failure.
   */
  it('stops waiting for idle after the cap and sweeps anyway', async () => {
    const gateway = fakeGateway({ idle: new Promise(() => undefined) });
    const waited: number[] = [];
    const { killSwitch, reads } = build({
      gateway,
      portfolios: [portfolioOf([order('o-1')]), portfolioOf([])],
      wait: async (ms) => {
        waited.push(ms);
      },
    });

    await killSwitch.engage('operator', 'drill');

    expect(waited).toStrictEqual([SWEEP_IDLE_WAIT_MS]);
    expect(reads()).toBe(2);
    expect(gateway.submitted).toStrictEqual([`kill:${ENGAGED_AT}:o-1`]);
  });
});

describe('KillSwitch resume and heartbeat', () => {
  it('resume() on a latched restart reports and sweeps again', async () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({
        engagedAt: '2026-09-01T00:00:00.000Z',
        source: 'operator',
        reason: 'x',
      }),
    );

    const gateway = fakeGateway();
    const { killSwitch, reporter } = build({
      gateway,
      portfolios: [portfolioOf([order('o-1')]), portfolioOf([])],
    });

    await killSwitch.resume();

    expect(reporter.lines[0]).toBe(
      '[error] the kill switch is still engaged from a previous run; delete kill-switch.json and restart to resume trading source=operator reason=x engagedAt=2026-09-01T00:00:00.000Z',
    );
    expect(gateway.submitted).toStrictEqual([
      'kill:2026-09-01T00:00:00.000Z:o-1',
    ]);
  });

  /**
   * A latch that came down in *this* run is not "from a previous run": the
   * operator has already been told, there is no file for them to delete that
   * they did not just watch appear, and the sweep is already running. `resume`
   * speaks only for a latch it found on disk at construction.
   */
  it('resume() is silent, and sweeps nothing new, after an engage in the same run', async () => {
    const gateway = fakeGateway();
    const { killSwitch, reporter, reads } = build({
      gateway,
      portfolios: [portfolioOf([order('o-1')]), portfolioOf([])],
    });

    await killSwitch.engage('submission-failures', '10 attempts');

    const lines = reporter.lines.length;
    const readsAfterEngage = reads();

    await killSwitch.resume();

    expect(reporter.lines.length).toBe(lines);
    expect(reporter.lines.join('\n')).not.toContain('from a previous run');
    expect(reads()).toBe(readsAfterEngage);
    expect(gateway.submitted).toStrictEqual([`kill:${ENGAGED_AT}:o-1`]);
  });

  it('resume() speaks once: a second call is silent', async () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({
        engagedAt: '2026-09-01T00:00:00.000Z',
        source: 'operator',
        reason: 'x',
      }),
    );

    const { killSwitch, reporter, reads } = build();

    await killSwitch.resume();

    const lines = reporter.lines.length;
    const readsAfterFirst = reads();

    await killSwitch.resume();

    expect(reporter.lines.length).toBe(lines);
    expect(reads()).toBe(readsAfterFirst);
  });

  it('resume() is silent when not engaged', async () => {
    const { killSwitch, reporter, reads } = build();

    await killSwitch.resume();

    expect(reporter.lines).toStrictEqual([]);
    expect(reads()).toBe(0);
  });

  it('heartbeats every HEARTBEAT_MS while engaged, and never otherwise', async () => {
    let at = ENGAGED_AT_MS;
    const { killSwitch, reporter } = build({ nowMs: () => at });

    killSwitch.heartbeat();
    expect(reporter.lines).toStrictEqual([]);

    await killSwitch.engage('operator', 'drill');

    const after = reporter.lines.length;

    at += HEARTBEAT_MS - 1;
    killSwitch.heartbeat();
    expect(reporter.lines.length).toBe(after);

    at += 1;
    killSwitch.heartbeat();
    expect(reporter.lines.at(-1)).toBe(
      `[warn] the kill switch is still engaged source=operator reason=drill engagedAt=${ENGAGED_AT}`,
    );

    killSwitch.heartbeat();
    expect(reporter.lines.length).toBe(after + 1);
  });
});
