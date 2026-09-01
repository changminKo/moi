import { randomUUID } from 'node:crypto';
import type { Broker, BrokerOrder } from '@moi/strategy-sdk';
import type { StrategyDecision, Tick } from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';
import type { Reporter } from '../reporter.js';
import { notionalOf } from '../risk/risk-gate.js';
import type { DecisionRecord, StateStore } from '../state/state-store.js';
import { deriveIdempotencyKey } from './idempotency.js';

/**
 * Design §6.2, exactly in its order:
 *
 * 1. append the decision to state — **durably**;
 * 2. derive the idempotency key from the recorded `decisionId`;
 * 3. promote the `OrderIntent` to a `PlaceOrderCommand` by adding the session
 *    and that key;
 * 4. submit.
 *
 * "A crash anywhere must recompute the same key on restart" is what this shape
 * buys, and each step earns part of it. Step 1 is fsynced before step 4 makes
 * anything visible outside the process, so there is no instant at which an order
 * exists that the state does not know about. Step 2 is a pure function of a
 * value that is now on disk, so the key is not something the runner has to
 * remember — it is something the runner can recompute. And because the ledger
 * scopes idempotency by `(session_id, key)`, resubmitting a recovered decision
 * replays the original order rather than placing a second one.
 *
 * The reverse ordering is the failure this prevents: submit first, record after,
 * and a crash in between leaves an order in the ledger that the runner will
 * never recognise as its own — so the next tick decides again, under a new key,
 * and the position doubles.
 *
 * ## Failure handling (§7.1), and what phase B does not do
 *
 * A `SESSION_EXPIRED` re-establishes the session once and retries under the
 * *unchanged* key. A retryable fault — `RATE_LIMITED`, `SERVICE_UNAVAILABLE` —
 * backs off and retries, also under the unchanged key. Anything else is a
 * verdict: it is recorded as a rejection and not retried, because reformulating
 * and resending is the one recovery that must not happen.
 *
 * §7.1 escalates a run of failures to the kill switch at ten. Phase B has no
 * kill switch — design §11 puts the submission barrier in phase D — so a
 * submission that exhausts its attempts is reported at `error` and **left
 * pending**. That is deliberate rather than a gap left open: a pending decision
 * is one the next start recovers and resubmits under the same key, which is the
 * safe state to be stuck in. What is missing is the escalation, not the
 * bookkeeping.
 */

export const MAX_SUBMIT_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 200;

export interface OrderGatewayOptions {
  readonly broker: Broker;
  readonly state: StateStore;
  /** The session in force now. Re-read per attempt, so a swap is picked up. */
  readonly sessionId: () => string;
  readonly reporter: Reporter;
  /** Re-establishes the session after a 401. Design §4.3, §7.1. */
  readonly reestablishSession: () => Promise<void>;
  readonly now?: () => number;
  readonly newDecisionId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
}

export interface SubmitResult {
  readonly decisionId: string;
  readonly outcome: 'accepted' | 'rejected' | 'pending';
  readonly orderId?: string;
}

export class OrderGateway {
  readonly #broker: Broker;
  readonly #state: StateStore;
  readonly #sessionId: () => string;
  readonly #reporter: Reporter;
  readonly #reestablish: () => Promise<void>;
  readonly #now: () => number;
  readonly #newDecisionId: () => string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxAttempts: number;

  constructor(options: OrderGatewayOptions) {
    this.#broker = options.broker;
    this.#state = options.state;
    this.#sessionId = options.sessionId;
    this.#reporter = options.reporter;
    this.#reestablish = options.reestablishSession;
    this.#now = options.now ?? Date.now;
    this.#newDecisionId = options.newDecisionId ?? randomUUID;
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxAttempts = options.maxAttempts ?? MAX_SUBMIT_ATTEMPTS;
  }

  /**
   * Step 1 alone: records the decision and hands back what was recorded. It is
   * separate from `submit` so a test can stop between them, which is precisely
   * the crash the restart criterion is about.
   *
   * `decisionId` is normally minted fresh, because a tick is a one-off and
   * nothing else could recompute an id for it. A decision derived from an
   * *account event* passes its own, derived from `(accountSequence, strategy,
   * index)`: that is what lets an uncommitted fill step be replayed after a
   * crash without placing a second order, since the idempotency key is a pure
   * function of the id. `appendDecision` is idempotent by the same id, so the
   * replay writes no second line either.
   */
  record(
    strategy: string,
    decision: StrategyDecision,
    tick: Tick,
    options: { readonly decisionId?: string } = {},
  ): DecisionRecord | null {
    const at = new Date(this.#now()).toISOString();

    if (decision.kind === 'noop') {
      this.#state.appendNoop({
        at,
        strategy,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      } as { at: string; strategy: string; reason: string });

      return null;
    }

    const base = {
      decisionId: options.decisionId ?? this.#newDecisionId(),
      at,
      strategy,
      reason: decision.reason,
    };
    const record: DecisionRecord =
      decision.kind === 'cancel'
        ? { ...base, kind: 'cancel', orderId: decision.orderId }
        : {
            ...base,
            kind: 'place',
            intent: decision.intent,
            // Recorded at decision time so the daily total can be rebuilt from
            // the log alone, without re-reading a market that has since moved.
            notional: notionalOf(decision.intent, tick),
          };

    this.#state.appendDecision(record);

    return record;
  }

  /** Steps 2 to 4, for a decision that is already on disk. */
  async submit(record: DecisionRecord): Promise<SubmitResult> {
    const idempotencyKey = deriveIdempotencyKey(record.decisionId);
    let reestablished = false;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const order = await this.#send(record, idempotencyKey);

        this.#state.appendSubmission({
          decisionId: record.decisionId,
          at: new Date(this.#now()).toISOString(),
          outcome: 'accepted',
          orderId: order.id,
          status: order.status,
        });
        this.#reporter.report('info', `the ${record.kind} was accepted`, {
          decisionId: record.decisionId,
          strategy: record.strategy,
          orderId: order.id,
          status: order.status,
          reason: record.reason,
        });

        return {
          decisionId: record.decisionId,
          outcome: 'accepted',
          orderId: order.id,
        };
      } catch (error) {
        const failure = asDomainError(error);

        // One re-establishment, then the 401 is treated like any other verdict.
        // The key does not change, so the retry replays rather than duplicates.
        if (failure.code === 'SESSION_EXPIRED' && !reestablished) {
          reestablished = true;
          await this.#reestablish();
          continue;
        }

        if (!failure.retryable || attempt === this.#maxAttempts) {
          return this.#settleOrLeavePending(record, failure, attempt);
        }

        this.#reporter.report('warn', `the ${record.kind} will be retried`, {
          decisionId: record.decisionId,
          attempt,
          code: failure.code,
        });
        await this.#sleep(backoffMs(attempt, failure.retryAfterSeconds));
      }
    }

    // Unreachable: the loop returns on the last attempt. Stated so a future
    // change to the loop cannot silently fall through to a success.
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'the submission loop ended without a verdict',
    );
  }

  /** Records the decision and submits it. The whole of §6.2 for a live tick. */
  async place(
    strategy: string,
    decision: StrategyDecision,
    tick: Tick,
  ): Promise<SubmitResult | null> {
    const record = this.record(strategy, decision, tick);

    return record === null ? null : this.submit(record);
  }

  /**
   * What a restart does first: finish every decision that was written down and
   * never got an outcome. Each is resubmitted under the key its own recorded
   * `decisionId` derives, so one that did reach the ledger before the crash
   * replays instead of placing a second order.
   */
  async recoverPending(): Promise<readonly SubmitResult[]> {
    const pending = this.#state.pendingDecisions();

    if (pending.length === 0) {
      return [];
    }

    this.#reporter.report(
      'warn',
      'resubmitting decisions that were recorded but never settled',
      { count: pending.length },
    );

    const results: SubmitResult[] = [];

    for (const record of pending) {
      results.push(await this.submit(record));
    }

    return Object.freeze(results);
  }

  async #send(
    record: DecisionRecord,
    idempotencyKey: string,
  ): Promise<BrokerOrder> {
    const sessionId = this.#sessionId();

    if (record.kind === 'cancel') {
      return this.#broker.cancelOrder({
        sessionId,
        idempotencyKey,
        orderId: record.orderId as string,
      });
    }

    // The promotion §6.2 describes: the intent, plus the two fields the gateway
    // owns and a strategy may not supply.
    return this.#broker.placeOrder({
      ...(record.intent as object),
      sessionId,
      idempotencyKey,
    } as Parameters<Broker['placeOrder']>[0]);
  }

  #settleOrLeavePending(
    record: DecisionRecord,
    failure: DomainError,
    attempts: number,
  ): SubmitResult {
    if (failure.retryable) {
      // Retries exhausted on a fault that may yet clear. Left pending on
      // purpose: the next start resubmits it under the same key, which is the
      // safe state to be stuck in. §7.1's escalation to the kill switch is
      // phase D.
      this.#reporter.report(
        'error',
        `the ${record.kind} could not be submitted and is left pending for the next start`,
        {
          decisionId: record.decisionId,
          strategy: record.strategy,
          attempts,
          code: failure.code,
        },
      );

      return { decisionId: record.decisionId, outcome: 'pending' };
    }

    this.#state.appendSubmission({
      decisionId: record.decisionId,
      at: new Date(this.#now()).toISOString(),
      outcome: 'rejected',
      code: failure.code,
    });
    this.#reporter.report('warn', `the ${record.kind} was rejected`, {
      decisionId: record.decisionId,
      strategy: record.strategy,
      code: failure.code,
      // The code, not the message: a message can carry whatever the server put
      // in it, and this line is on its way to a chat channel.
      reason: record.reason,
    });

    return { decisionId: record.decisionId, outcome: 'rejected' };
  }
}

/**
 * A network failure is not a `DomainError`, and it is exactly the case that has
 * to be retried under the unchanged key: the request may well have been
 * received. Anything that is not already classified is therefore treated as a
 * retryable service fault rather than as a verdict on the order.
 */
function asDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) {
    return error;
  }

  return new DomainError(
    'SERVICE_UNAVAILABLE',
    error instanceof Error ? error.message : String(error),
  );
}

/** Exponential, and the server's own `Retry-After` wins when it gave one. */
function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1_000;
  }

  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}
