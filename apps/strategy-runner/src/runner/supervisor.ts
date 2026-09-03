import type { BrokerPortfolio } from '@moi/strategy-sdk';
import { PaperBroker } from '@moi/strategy-sdk';
import type {
  StrategyDecision,
  StrategyState,
  Tick,
} from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';
import type { TickRecorder } from '../backtest/tick-log.js';
import type { RunnerConfig } from '../config.js';
import { MarketFeed } from '../feed/market-feed.js';
import { MarketSessionCache } from '../feed/market-session.js';
import {
  type FeedCursors,
  instrumentKey,
  QuoteTicker,
} from '../feed/quote-ticker.js';
import { RestQuoteFeed } from '../feed/rest-quote-feed.js';
import {
  StreamClient,
  type StreamSocketFactory,
} from '../feed/stream-client.js';
import { FillProcessor } from '../fills/fill-processor.js';
import { OrderGateway } from '../gateway/order-gateway.js';
import type { Reporter } from '../reporter.js';
import { RiskGate } from '../risk/risk-gate.js';
import { SessionClient } from '../session/session-client.js';
import { StateStore } from '../state/state-store.js';
import {
  type FetchLike,
  PaperApiClient,
} from '../transport/paper-api-client.js';
import { KillSwitch } from './kill-switch.js';
import { RunnerContext } from './runner-context.js';
import { StrategyHost } from './strategy-host.js';

/**
 * The runner (design §3): configuration, session persistence, the REST feed,
 * state, risk and the order gateway, wired together and driven by a poll loop.
 *
 * The cycle is deliberately sequential and deliberately short:
 *
 * 0. look for the operator's kill-switch file and ask the risk gate whether a
 *    loss limit has tripped — either engages the kill switch (phase D);
 * 1. read the portfolio — the ledger is the source of truth (§7.3), so every
 *    cycle starts by asking it rather than by trusting what the runner recorded;
 * 2. poll the quote for each instrument and derive ticks;
 * 3. hand each tick to the one strategy that owns its instrument (§6.3);
 * 4. put each resulting decision through the risk gate, then the gateway;
 * 5. persist the feed cursors and each strategy's snapshot.
 *
 * Step 5 is last because everything before it can throw, and a cursor written
 * for a cycle that did not finish would claim an observation that was not made.
 *
 * With the kill switch engaged the cycle still runs steps 0–2 and 5 — the feed
 * drains, the recorder records, the cursors move — and skips only the hand-off
 * to a strategy in step 3. The runner is watching, not trading.
 */

export interface SupervisorOptions {
  readonly config: RunnerConfig;
  readonly reporter: Reporter;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so a test can drive the socket. Defaults to Node's `WebSocket`. */
  readonly socketFactory?: StreamSocketFactory;
  /**
   * Where to write the tick series, when the operator asked for one
   * (`BOT_TICK_LOG`). Absent by default: recording is opt-in because the log
   * does not rotate, and design §8.4 makes it the *only* backtest input there
   * is, so an operator who wants to replay a period has to have decided to
   * record it before that period happened.
   */
  readonly recorder?: TickRecorder;
}

/**
 * How long `start()` waits for the paper API to report `runtime: 'SERVING'`
 * before connecting anyway, and how often it asks. A deploy restarts the bot
 * alongside the API, and the API spends ~20 s in RESTORING → ACQUIRING_LEASES
 * → RECOVERING first; a WebSocket upgrade in that window is a 503 the socket
 * cannot tell from any other refusal, so without this wait every deploy opened
 * with five `stream errored` embeds and the hold band (#112). The deadline is
 * a ceiling: past it the runner proceeds and the reconnect policy takes over,
 * exactly as before — it never refuses to start over a slow API.
 */
export const SERVING_WAIT_MS = 120_000;
export const SERVING_POLL_MS = 1_000;

interface RuntimeCell {
  readonly cursors: FeedCursors;
  readonly strategies: Readonly<Record<string, StrategyState>>;
}

function readRuntimeCell(saved: unknown): RuntimeCell {
  const source = (saved ?? {}) as Record<string, unknown>;
  const cursors = source.cursors;
  const strategies = source.strategies;

  return {
    cursors:
      typeof cursors === 'object' && cursors !== null && !Array.isArray(cursors)
        ? (cursors as FeedCursors)
        : {},
    strategies:
      typeof strategies === 'object' &&
      strategies !== null &&
      !Array.isArray(strategies)
        ? (strategies as Readonly<Record<string, StrategyState>>)
        : {},
  };
}

export class RunnerSupervisor {
  readonly #config: RunnerConfig;
  readonly #reporter: Reporter;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #state: StateStore;
  readonly #session: SessionClient;
  readonly #api: PaperApiClient;
  readonly #broker: PaperBroker;
  readonly #ticker: QuoteTicker;
  readonly #feed: MarketFeed;
  readonly #stream: StreamClient;
  readonly #fills: FillProcessor;
  readonly #risk: RiskGate;
  readonly #gateway: OrderGateway;
  readonly #killSwitch: KillSwitch;
  readonly #context: RunnerContext;
  readonly #hosts: readonly StrategyHost[];
  readonly #owner: ReadonlyMap<string, StrategyHost>;
  readonly #recorder: TickRecorder | null;
  #running = false;
  /** Set by `stop()`; `start()`'s wait and `run()` both honour it. */
  #stopped = false;

  constructor(options: SupervisorOptions) {
    this.#config = options.config;
    this.#reporter = options.reporter;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#state = StateStore.open({ directory: options.config.stateDir });
    this.#context = new RunnerContext(this.#now);

    const runtime = readRuntimeCell(this.#state.runtime.read());

    this.#api = new PaperApiClient({
      origin: options.config.apiOrigin,
      publicOrigin: options.config.publicOrigin,
      credentials: () => this.#session.credentials(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#session = new SessionClient({
      api: this.#api,
      cell: this.#state.session,
      reporter: options.reporter,
    });
    this.#broker = new PaperBroker(this.#api.brokerTransport());
    this.#ticker = new QuoteTicker({
      gapAfterMs: options.config.gapAfterMs,
      now: this.#now,
      cursors: runtime.cursors,
      onGap: (gap) =>
        options.reporter.report('warn', 'a market-data gap was observed', {
          ...gap,
        }),
    });
    // The three reference each other, and every reference is a closure read at
    // call time rather than a value read now: the stream hands frames to the
    // feed, asks the fill processor for its cursor, and the fill processor is
    // built last because it needs the gateway.
    this.#stream = new StreamClient({
      origin: options.config.apiOrigin,
      publicOrigin: options.config.publicOrigin,
      credentials: () => this.#session.credentials(),
      instruments: options.config.subscriptions,
      cursor: () => this.#fills.cursor(),
      reporter: options.reporter,
      handlers: {
        onReady: (accountSequence) =>
          options.reporter.report('info', 'the market stream is ready', {
            accountSequence,
          }),
        onQuote: (market, symbol, payload) =>
          this.#feed.observeFrame(market, symbol, payload),
        onEvent: (event) => this.#fills.process(event),
        onResync: (reason) => this.#fills.resync(reason),
        // §5.3: quotes are not replayed, so a connection that comes back
        // knows nothing until the book next moves. One REST read per
        // instrument puts a price in front of the strategy now.
        onConnected: () => this.#feed.rebaseline(),
      },
      ...(options.socketFactory === undefined
        ? {}
        : { socketFactory: options.socketFactory }),
    });
    this.#feed = new MarketFeed({
      instruments: options.config.subscriptions,
      ticker: this.#ticker,
      rest: new RestQuoteFeed({
        api: this.#api,
        instruments: options.config.subscriptions,
        reporter: options.reporter,
        ticker: this.#ticker,
      }),
      stream: this.#stream,
      reporter: options.reporter,
      maxQuoteAgeMs: options.config.risk.maxQuoteAgeMs,
    });
    this.#risk = new RiskGate({
      limits: options.config.risk,
      sessions: new MarketSessionCache({ api: this.#api, now: this.#now }),
      state: this.#state,
      now: this.#now,
    });
    this.#gateway = new OrderGateway({
      broker: this.#broker,
      state: this.#state,
      sessionId: () => {
        const credentials = this.#session.credentials();

        if (credentials === null) {
          throw new DomainError(
            'SESSION_EXPIRED',
            'the runner has no session to submit under',
          );
        }

        return credentials.sessionId;
      },
      reporter: options.reporter,
      reestablishSession: async () => {
        await this.#session.reestablish();
      },
      now: this.#now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      // Both read `#killSwitch` at call time; it is built just below, after the
      // gateway it needs for its sweep.
      barrier: (kind) => this.#killSwitch.permits(kind),
      onExhausted: ({ code, consecutiveFailures }) => {
        void this.#killSwitch.engage(
          'submission-failures',
          `${consecutiveFailures} submission attempts failed in a row`,
          { code, consecutiveFailures },
        );
      },
    });
    this.#killSwitch = new KillSwitch({
      cell: this.#state.killSwitch,
      gateway: this.#gateway,
      portfolio: () => this.#portfolio(),
      reporter: options.reporter,
      now: this.#now,
    });
    this.#hosts = Object.freeze(
      options.config.strategies.map(
        (configured) =>
          new StrategyHost({ configured, reporter: options.reporter }),
      ),
    );

    const owner = new Map<string, StrategyHost>();

    // Configuration has already refused a duplicate instrument (§6.3), so this
    // map is total and unambiguous by the time it is built.
    for (const [index, configured] of options.config.strategies.entries()) {
      for (const reference of configured.subscriptions) {
        owner.set(instrumentKey(reference), this.#hosts[index] as StrategyHost);
      }
    }

    this.#owner = owner;
    this.#recorder = options.recorder ?? null;
    this.#runtime = runtime;
    this.#fills = new FillProcessor({
      state: this.#state,
      gateway: this.#gateway,
      reporter: options.reporter,
      context: this.#context,
      owner,
      portfolio: () => this.#portfolio(),
      now: this.#now,
      killSwitch: this.#killSwitch,
    });
  }

  #runtime: RuntimeCell;

  get state(): StateStore {
    return this.#state;
  }

  get killSwitch(): KillSwitch {
    return this.#killSwitch;
  }

  /**
   * Establishes the session, finishes anything the last run left unsubmitted,
   * and restores each strategy's window.
   *
   * The recovery runs **before** the first tick, deliberately: a decision that
   * was recorded and never submitted is an order the ledger may already hold,
   * and letting a strategy decide again first would have it deciding against a
   * portfolio that is about to change.
   */
  async start(): Promise<void> {
    await this.#awaitServing();

    // A SIGTERM that arrived while we were waiting for the API: there is no
    // session to establish and no stream to arm — `run()` will return at once.
    if (this.#stopped) {
      return;
    }

    await this.#session.establish();
    await this.#gateway.recoverPending();
    // A latch found on disk is announced and swept again before any strategy
    // is restored — the pending cancels `recoverPending` just resubmitted are
    // the recorded half of an interrupted sweep; this reads the rest.
    await this.#killSwitch.resume();

    for (const host of this.#hosts) {
      host.start(this.#runtime.strategies[host.name] ?? null, this.#context);
    }

    // Last: the socket starts replaying account events as soon as it is up, and
    // an event that reaches `FillProcessor` before `recoverPending` has run
    // would race a decision the previous process left unsettled.
    this.#stream.start();
  }

  /**
   * `GET /health/market-data` → its `runtime`, or `null` when the API cannot
   * be asked (connection refused, non-JSON). Unauthenticated: the route is
   * public and this runs before there is a session.
   */
  async #runtimeState(): Promise<{
    readonly runtime: string | null;
    /** The HTTP status, or `null` when no response came back at all. */
    readonly status: number | null;
  }> {
    try {
      const response = await this.#api.send({
        method: 'GET',
        path: '/health/market-data',
        authenticated: false,
      });
      const runtime = (response.body as { runtime?: unknown } | undefined)
        ?.runtime;

      return {
        runtime: typeof runtime === 'string' ? runtime : null,
        status: response.status,
      };
    } catch (error) {
      // Only the network is swallowed here — an API that is not listening yet
      // is exactly what this wait is for. A refusal by the client itself (an
      // origin or path it will not talk to) is a configuration fault and stays
      // fail-closed.
      if (error instanceof DomainError) {
        throw error;
      }

      return { runtime: null, status: null };
    }
  }

  /**
   * Waits until the API is SERVING, until SERVING_WAIT_MS has passed (plus at
   * most one request timeout — the deadline is checked between probes), or
   * until `stop()` is called.
   */
  async #awaitServing(): Promise<void> {
    const startedAt = this.#now();
    const deadline = startedAt + SERVING_WAIT_MS;
    let announced = false;

    for (;;) {
      // Stopped before we ever asked (a signal that beat `start()`): silent.
      if (this.#stopped) {
        return;
      }

      const { runtime, status } = await this.#runtimeState();
      // `unreachable` is reserved for no response at all; an answer without a
      // usable `runtime` is named by its status.
      const seen =
        runtime ?? (status === null ? 'unreachable' : `http ${status}`);

      if (runtime === 'SERVING') {
        if (announced) {
          this.#reporter.report('info', 'the paper API is serving', {
            waitedMs: this.#now() - startedAt,
          });
        }

        return;
      }

      if (this.#now() >= deadline) {
        this.#reporter.report(
          'warn',
          'the paper API did not reach SERVING before the wait ran out; connecting anyway',
          { runtime: seen, waitedMs: this.#now() - startedAt },
        );

        return;
      }

      if (!announced) {
        announced = true;
        this.#reporter.report(
          'info',
          'the paper API is not serving yet; waiting before the first connect',
          { runtime: seen },
        );
      }

      // A stop that landed while the probe was in flight: do not sleep on it.
      if (this.#stopped) {
        return;
      }

      await this.#sleep(SERVING_POLL_MS);
    }
  }

  /** One pass. Separated from `run` so a test can drive the loop by hand. */
  async cycle(): Promise<void> {
    await this.#killSwitch.observeOperatorFile();

    if (!this.#killSwitch.engaged) {
      const breach = this.#risk.lossLimitBreach();

      if (breach !== null) {
        await this.#killSwitch.engage('loss-limit', breach);
      }
    }

    const portfolio = await this.#portfolio();

    this.#context.observePortfolio(portfolio);

    const ticks = await this.#feed.drain();

    for (const tick of ticks) {
      await this.#applyTick(tick, portfolio);
    }

    this.#persist();
    this.#killSwitch.heartbeat();
  }

  async run(): Promise<void> {
    if (this.#stopped) {
      return;
    }

    this.#running = true;

    while (this.#running) {
      try {
        await this.cycle();
      } catch (error) {
        // A cycle that fails is a cycle skipped, not a runner that dies. The
        // ledger is unaffected either way (§7.3), and the next cycle re-reads
        // everything it needs.
        this.#reporter.report('error', 'a runner cycle failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await this.#sleep(this.#config.pollIntervalMs);
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#running = false;
    this.#stream.stop();
  }

  close(): void {
    this.#stream.stop();
    this.#recorder?.close();
    this.#state.close();
  }

  /** The ledger's own view, with one session re-establishment on a 401 (§7.1). */
  async #portfolio(): Promise<BrokerPortfolio> {
    const credentials = this.#session.credentials();

    if (credentials === null) {
      throw new DomainError(
        'SESSION_EXPIRED',
        'the runner has no session; start() must run first',
      );
    }

    try {
      return await this.#broker.getPortfolio(credentials.sessionId);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'SESSION_EXPIRED') {
        throw error;
      }

      const replacement = await this.#session.reestablish();

      return this.#broker.getPortfolio(replacement.sessionId);
    }
  }

  async #applyTick(tick: Tick, portfolio: BrokerPortfolio): Promise<void> {
    // Recorded before anything acts on it, so a replay sees the series the
    // strategies saw — including a tick no strategy owns, because a backtest of
    // a *different* configuration may well own it.
    this.#recorder?.record(tick);
    this.#context.observeTick(tick);

    // Engaged: the feed, the recorder and the cursors carry on — the runner is
    // watching, not trading — and the one thing that stops is this hand-off.
    if (this.#killSwitch.engaged) {
      return;
    }

    const host = this.#owner.get(instrumentKey(tick));

    if (host === undefined) {
      return;
    }

    for (const decision of host.onTick(tick, this.#context)) {
      await this.#applyDecision(host.name, decision, tick, portfolio);
    }
  }

  async #applyDecision(
    strategy: string,
    decision: StrategyDecision,
    tick: Tick,
    portfolio: BrokerPortfolio,
  ): Promise<void> {
    if (decision.kind === 'noop') {
      this.#state.appendNoop({
        at: new Date(this.#now()).toISOString(),
        strategy,
        reason: decision.reason ?? 'unstated',
      });

      return;
    }

    // A cancel reduces exposure and names an order rather than an instrument, so
    // there is nothing for the gate to size. Phase A's strategy never returns
    // one; the path exists because the decision type does.
    if (decision.kind === 'place') {
      const verdict = await this.#risk.evaluate({
        intent: decision.intent,
        tick,
        portfolio,
      });

      if (!verdict.allowed) {
        this.#state.appendRefusal({
          at: new Date(this.#now()).toISOString(),
          strategy,
          reason: decision.reason,
          refusal: verdict.reason,
        });
        this.#reporter.report('info', 'the risk gate refused an order', {
          strategy,
          reason: decision.reason,
          refusal: verdict.reason,
        });

        return;
      }
    }

    await this.#gateway.place(strategy, decision, tick);
  }

  /**
   * The feed cursors and each strategy's window, as one atomic replacement. One
   * cell rather than two because they are read together at start and a restart
   * that got one without the other would resume a window against a cursor that
   * did not match it.
   */
  #persist(): void {
    const strategies: Record<string, StrategyState> = {
      ...this.#runtime.strategies,
    };

    for (const host of this.#hosts) {
      const snapshot = host.snapshot();

      if (snapshot !== null) {
        strategies[host.name] = snapshot;
      }
    }

    this.#runtime = { cursors: this.#ticker.cursors(), strategies };
    this.#state.runtime.write({
      cursors: this.#runtime.cursors,
      strategies: this.#runtime.strategies,
    });
  }
}
