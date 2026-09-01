import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type {
  Strategy,
  StrategyDecision,
  Tick,
} from '@moi/strategy-sdk/strategy';
import { describe, expect, it } from 'vitest';
import type { ConfiguredStrategy } from '../config.js';
import { createRecordingReporter } from '../reporter.js';
import { RunnerContext, WINDOW_LENGTH } from './runner-context.js';
import { StrategyHost } from './strategy-host.js';

const TICK: Tick = Object.freeze({
  market: 'KR',
  symbol: '005930',
  price: '70000',
  priceSource: 'rest-snapshot',
  bestBid: '69900',
  bestAsk: '70100',
  asOf: '2026-09-02T02:00:00.000Z',
  marketDataVersion: '1',
  gapBefore: false,
});

const NOOP: StrategyDecision = Object.freeze({
  kind: 'noop',
  reason: 'no-cross',
});

interface Behaviour {
  readonly onTick?: (tick: Tick) => readonly StrategyDecision[];
  readonly onStart?: () => void;
  readonly snapshot?: () => Record<string, never>;
}

function hostOver(behaviour: Behaviour, quarantineAfter?: number) {
  const strategy: Strategy<unknown> = {
    id: 'test-strategy',
    parameterSchema: {
      fieldNames: [],
      describe: () => [],
      parse: () => ({}),
    },
    subscriptions: () => [{ market: 'KR', symbol: '005930' }],
    onTick: behaviour.onTick ?? (() => [NOOP]),
    ...(behaviour.onStart === undefined ? {} : { onStart: behaviour.onStart }),
    ...(behaviour.snapshot === undefined
      ? {}
      : { snapshot: behaviour.snapshot }),
  };
  const configured: ConfiguredStrategy = {
    name: 'tester',
    strategy,
    params: {},
    subscriptions: [{ market: 'KR', symbol: '005930' }],
  };
  const reporter = createRecordingReporter();

  return {
    reporter,
    host: new StrategyHost({
      configured,
      reporter,
      ...(quarantineAfter === undefined ? {} : { quarantineAfter }),
    }),
  };
}

const context = new RunnerContext(() => Date.parse('2026-09-02T02:00:00.000Z'));

describe('StrategyHost containment', () => {
  it('passes decisions through when the strategy behaves', () => {
    const { host } = hostOver({});

    expect(host.onTick(TICK, context)).toStrictEqual([NOOP]);
    expect(host.quarantined).toBe(false);
  });

  it('contains a throw, decides nothing, and reports it', () => {
    const { host, reporter } = hostOver({
      onTick: () => {
        throw new Error('price is not a number');
      },
    });

    expect(host.onTick(TICK, context)).toStrictEqual([]);
    expect(host.quarantined).toBe(false);
    expect(reporter.lines[0]).toBe(
      '[warn] a strategy threw on a tick strategy=tester consecutiveFailures=1 error=price is not a number',
    );
  });

  /**
   * Phase A's remaining throwing case — a malformed price — recovers on the very
   * next valid tick. A cumulative counter would eventually quarantine a strategy
   * doing exactly that, correctly, so one good tick clears the count.
   */
  it('clears the failure count on a tick that succeeds', () => {
    let fail = true;
    const { host } = hostOver({
      onTick: () => {
        if (fail) {
          throw new Error('malformed price');
        }

        return [NOOP];
      },
    });

    host.onTick(TICK, context);
    host.onTick(TICK, context);
    fail = false;
    host.onTick(TICK, context);
    fail = true;
    host.onTick(TICK, context);
    host.onTick(TICK, context);

    expect(host.quarantined).toBe(false);
  });

  it('quarantines after three consecutive throws', () => {
    const { host, reporter } = hostOver({
      onTick: () => {
        throw new Error('broken');
      },
    });

    host.onTick(TICK, context);
    host.onTick(TICK, context);

    expect(host.quarantined).toBe(false);

    host.onTick(TICK, context);

    expect(host.quarantined).toBe(true);
    expect(reporter.lines.at(-1)).toMatch(
      /\[error\] a strategy threw on 3 consecutive ticks and is quarantined/u,
    );
  });

  it('stops calling a quarantined strategy at all', () => {
    let calls = 0;
    const { host } = hostOver({
      onTick: () => {
        calls += 1;

        throw new Error('broken');
      },
    });

    for (let tick = 0; tick < 10; tick += 1) {
      host.onTick(TICK, context);
    }

    expect(calls).toBe(3);
  });

  /** Quarantine stops decisions. It does not touch orders or positions — §7.2. */
  it('says plainly that a quarantine leaves the position alone', () => {
    const { host, reporter } = hostOver(
      {
        onTick: () => {
          throw new Error('broken');
        },
      },
      1,
    );

    host.onTick(TICK, context);

    expect(reporter.lines[0]).toMatch(
      /its open orders and position are untouched and need a person/u,
    );
  });

  /** A strategy is caller code, so what it returns is validated like input. */
  it('treats a malformed decision as a throw', () => {
    const { host, reporter } = hostOver({
      onTick: () => [{ kind: 'place' } as unknown as StrategyDecision],
    });

    expect(host.onTick(TICK, context)).toStrictEqual([]);
    expect(reporter.lines[0]).toMatch(/a strategy threw on a tick/u);
  });
});

describe('StrategyHost lifecycle', () => {
  it('quarantines immediately when the state cannot be restored', () => {
    const { host, reporter } = hostOver({
      onStart: () => {
        throw new Error('window is for a different instrument');
      },
    });

    host.start({}, context);

    expect(host.quarantined).toBe(true);
    expect(reporter.lines[0]).toMatch(
      /could not restore its state and is quarantined/u,
    );
  });

  /**
   * The bug an integration run found: a fresh state directory made the runner
   * call `onStart({})`, phase A's reader refused a window naming no instrument,
   * and the strategy was quarantined before it had seen one tick.
   */
  it('does not ask a strategy to restore state that does not exist', () => {
    let called = 0;
    const { host } = hostOver({
      onStart: () => {
        called += 1;

        throw new Error('window is for a different instrument');
      },
    });

    host.start(null, context);

    expect(called).toBe(0);
    expect(host.quarantined).toBe(false);
    expect(host.onTick(TICK, context)).toStrictEqual([NOOP]);
  });

  it('holds back a snapshot until there is something to snapshot', () => {
    const { host, reporter } = hostOver({ snapshot: () => ({}) });

    expect(host.snapshot()).toBeNull();

    host.onTick(TICK, context);

    expect(host.snapshot()).toStrictEqual({});
    expect(reporter.lines).toStrictEqual([]);
  });

  it('tolerates a strategy that publishes no lifecycle hooks', () => {
    const { host } = hostOver({});

    host.start({}, context);

    expect(host.snapshot()).toBeNull();
    expect(host.quarantined).toBe(false);
  });

  /**
   * A snapshot that fails costs a warm-up after the next restart and nothing
   * else, so it is not worth quarantining a strategy that is deciding correctly.
   */
  it('warns but does not quarantine when a snapshot fails', () => {
    const { host, reporter } = hostOver({
      snapshot: () => {
        throw new Error('no state to snapshot');
      },
    });

    host.onTick(TICK, context);

    expect(host.snapshot()).toBeNull();
    expect(host.quarantined).toBe(false);
    expect(reporter.lines[0]).toMatch(/could not be snapshotted/u);
  });
});

describe('RunnerContext', () => {
  const portfolio = (total: string): BrokerPortfolio =>
    ({
      sessionId: 's-1',
      wallets: [],
      positions: [
        {
          market: 'KR',
          symbol: '005930',
          total,
          available: total,
          reserved: '0',
          averageCost: '69000',
        },
      ],
      activeOrders: [],
      accountSequence: '1',
    }) as BrokerPortfolio;

  it('answers the clock it was given, and nothing else', () => {
    expect(context.now()).toBe('2026-09-02T02:00:00.000Z');
  });

  /** §7.3: the ledger owns the position; the context reports what it said. */
  it('projects the ledger position, narrowed to the strategy contract', () => {
    const live = new RunnerContext(() => 0);

    live.observePortfolio(portfolio('5'));

    expect(live.position({ market: 'KR', symbol: '005930' })).toStrictEqual({
      market: 'KR',
      symbol: '005930',
      total: '5',
      available: '5',
      averageCost: '69000',
    });
  });

  it('answers null for an instrument the ledger holds nothing of', () => {
    const live = new RunnerContext(() => 0);

    live.observePortfolio(portfolio('5'));

    expect(live.position({ market: 'KR', symbol: '000660' })).toBeNull();
    expect(live.position({ market: 'US', symbol: '005930' })).toBeNull();
  });

  it('keeps a bounded window, newest last', () => {
    const live = new RunnerContext(() => 0);

    for (let version = 0; version < WINDOW_LENGTH + 10; version += 1) {
      live.observeTick({ ...TICK, marketDataVersion: String(version) });
    }

    const window = live.window({ market: 'KR', symbol: '005930' });

    expect(window).toHaveLength(WINDOW_LENGTH);
    expect(window.at(-1)?.marketDataVersion).toBe(String(WINDOW_LENGTH + 9));
  });

  it('resets the window across a gap rather than spanning one', () => {
    const live = new RunnerContext(() => 0);

    live.observeTick(TICK);
    live.observeTick({ ...TICK, gapBefore: true, price: '80000' });

    expect(
      live.window({ market: 'KR', symbol: '005930' }).map((tick) => tick.price),
    ).toStrictEqual(['80000']);
  });

  it('keeps one window per instrument', () => {
    const live = new RunnerContext(() => 0);

    live.observeTick(TICK);
    live.observeTick({ ...TICK, symbol: '000660' });

    expect(live.window({ market: 'KR', symbol: '005930' })).toHaveLength(1);
    expect(live.window({ market: 'KR', symbol: '000660' })).toHaveLength(1);
  });
});
