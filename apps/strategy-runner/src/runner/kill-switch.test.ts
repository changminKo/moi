import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { StrategyDecision, Tick } from '@moi/strategy-sdk/strategy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubmitResult } from '../gateway/order-gateway.js';
import { createRecordingReporter } from '../reporter.js';
import { JsonCell } from '../state/json-cell.js';
import type { DecisionRecord } from '../state/state-store.js';
import { HEARTBEAT_MS, KillSwitch, MAX_SWEEP_PASSES } from './kill-switch.js';

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
  } = {},
) {
  const reporter = createRecordingReporter();
  const gateway = options.gateway ?? fakeGateway();
  const snapshots = [...(options.portfolios ?? [portfolioOf([])])];
  let reads = 0;
  const killSwitch = new KillSwitch({
    cell: new JsonCell(join(directory, 'kill-switch.json')),
    gateway,
    portfolio: async () => {
      reads += 1;

      return snapshots.length > 1
        ? (snapshots.shift() as BrokerPortfolio)
        : (snapshots[0] as BrokerPortfolio);
    },
    reporter,
    now: options.nowMs ?? (() => ENGAGED_AT_MS),
  });

  return { killSwitch, gateway, reporter, reads: () => reads };
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

  it('adopts an operator file found at construction as an operator engagement', () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ reason: 'written before start' }),
    );

    const { killSwitch } = build();

    expect(killSwitch.engagement).toStrictEqual({
      engagedAt: ENGAGED_AT,
      source: 'operator',
      reason: 'written before start',
    });
    expect(latch()).toStrictEqual({
      engagedAt: ENGAGED_AT,
      source: 'operator',
      reason: 'written before start',
    });
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

  it('reports a sweep that throws instead of rejecting engage', async () => {
    const gateway = fakeGateway();

    gateway.submit = async () => {
      throw new Error('boom');
    };

    const { killSwitch, reporter } = build({
      gateway,
      portfolios: [portfolioOf([order('o-1')])],
    });

    await expect(
      killSwitch.engage('operator', 'drill'),
    ).resolves.toBeUndefined();
    expect(killSwitch.engaged).toBe(true);
    expect(reporter.lines.at(-1)).toBe(
      '[error] the cancel sweep failed error=boom',
    );
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
