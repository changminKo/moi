import type { BrokerPortfolio } from '@moi/strategy-sdk';
import { PaperBroker } from '@moi/strategy-sdk';
import type {
  StrategyDecision,
  StrategyState,
  Tick,
} from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';
import type { RunnerConfig } from '../config.js';
import { MarketSessionCache } from '../feed/market-session.js';
import {
  type FeedCursors,
  instrumentKey,
  RestQuoteFeed,
} from '../feed/rest-quote-feed.js';
import { OrderGateway } from '../gateway/order-gateway.js';
import type { Reporter } from '../reporter.js';
import { RiskGate } from '../risk/risk-gate.js';
import { SessionClient } from '../session/session-client.js';
import { StateStore } from '../state/state-store.js';
import {
  type FetchLike,
  PaperApiClient,
} from '../transport/paper-api-client.js';
import { RunnerContext } from './runner-context.js';
import { StrategyHost } from './strategy-host.js';

/**
 * The runner (design §3): configuration, session persistence, the REST feed,
 * state, risk and the order gateway, wired together and driven by a poll loop.
 *
 * The cycle is deliberately sequential and deliberately short:
 *
 * 1. read the portfolio — the ledger is the source of truth (§7.3), so every
 *    cycle starts by asking it rather than by trusting what the runner recorded;
 * 2. poll the quote for each instrument and derive ticks;
 * 3. hand each tick to the one strategy that owns its instrument (§6.3);
 * 4. put each resulting decision through the risk gate, then the gateway;
 * 5. persist the feed cursors and each strategy's snapshot.
 *
 * Step 5 is last because everything before it can throw, and a cursor written
 * for a cycle that did not finish would claim an observation that was not made.
 */

export interface SupervisorOptions {
  readonly config: RunnerConfig;
  readonly reporter: Reporter;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

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
  readonly #feed: RestQuoteFeed;
  readonly #risk: RiskGate;
  readonly #gateway: OrderGateway;
  readonly #context: RunnerContext;
  readonly #hosts: readonly StrategyHost[];
  readonly #owner: ReadonlyMap<string, StrategyHost>;
  #running = false;

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
    this.#feed = new RestQuoteFeed({
      api: this.#api,
      instruments: options.config.subscriptions,
      gapAfterMs: options.config.gapAfterMs,
      reporter: options.reporter,
      now: this.#now,
      cursors: runtime.cursors,
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
    this.#runtime = runtime;
  }

  #runtime: RuntimeCell;

  get state(): StateStore {
    return this.#state;
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
    await this.#session.establish();
    await this.#gateway.recoverPending();

    for (const host of this.#hosts) {
      host.start(this.#runtime.strategies[host.name] ?? null, this.#context);
    }
  }

  /** One pass. Separated from `run` so a test can drive the loop by hand. */
  async cycle(): Promise<void> {
    const portfolio = await this.#portfolio();

    this.#context.observePortfolio(portfolio);

    const ticks = await this.#feed.poll();

    for (const tick of ticks) {
      await this.#applyTick(tick, portfolio);
    }

    this.#persist();
  }

  async run(): Promise<void> {
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
    this.#running = false;
  }

  close(): void {
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
    this.#context.observeTick(tick);

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

    this.#runtime = { cursors: this.#feed.cursors(), strategies };
    this.#state.runtime.write({
      cursors: this.#runtime.cursors,
      strategies: this.#runtime.strategies,
    });
  }
}
