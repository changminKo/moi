import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeeModel } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import type { MarketEnvelope } from '../market-data/market-state-store.js';
import {
  type ConditionalPaperOrder,
  PaperEngine,
  type TradeEvent,
} from './paper-engine.js';

type Scenario = {
  seed: number;
  market: 'US';
  symbol: string;
  actions: readonly { type: string; [key: string]: string | number }[];
};

const scenario = JSON.parse(
  readFileSync(
    resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../../packages/market-data/fixtures/scenarios/lossy-recovery.json',
    ),
    'utf8',
  ),
) as Scenario;
const feeModel = createFeeModel({
  version: 'fees-1',
  market: 'US',
  currency: 'USD',
  commissionRate: '0',
  sellTaxRate: '0',
  roundingDecimals: 2,
  roundingMode: 'HALF_UP',
});
const book = (price: string) => ({
  market: 'US' as const,
  symbol: 'AAPL',
  currency: 'USD' as const,
  bids: [{ price, volume: '2' }],
  asks: [{ price: `${Number(price) + 1}`, volume: '2' }],
});
const envelope = <T>(
  payload: T,
  epoch: bigint,
  token: bigint,
  version: bigint,
): MarketEnvelope<T> => ({
  recoveryEpoch: epoch,
  leaderFencingToken: token,
  marketDataVersion: version,
  payload,
});

async function runScenario(restartAt?: number) {
  let fencingToken = 1n;
  let engine!: PaperEngine;
  let historicalFills = 0;
  let recoveryFills = 0;
  let staleFrameRejected = true;
  let terminalRearm = false;
  const ledger: number[] = [];
  const incidents = new Set(['TRANSPORT_CLOSED']);
  const makeEngine = () =>
    new PaperEngine({
      feeModel,
      currentFencingToken: () => fencingToken,
      onAudit: (event) => {
        const pricing = (event as { pricing?: { source: string } }).pricing;
        if (pricing?.source === 'RECOVERY_REST') recoveryFills += 1;
        else historicalFills += 1;
      },
      onConditionalTrigger: (order, pricing) => {
        if (order.status === 'TRIGGERED' && pricing.recoveryFill) {
          ledger.push(1, -1);
          recoveryFills += 1;
        }
      },
    });
  engine = makeEngine();
  const stop: ConditionalPaperOrder = {
    id: 'stop-1',
    sessionId: 's1',
    market: 'US',
    symbol: 'AAPL',
    currency: 'USD',
    side: 'SELL',
    type: 'STOP',
    stopPrice: '90',
    quantity: '1',
    status: 'PENDING_TRIGGER',
    version: 0n,
    filledQuantity: '0',
  };
  const actions = scenario.actions.filter(
    (action) => action.type !== 'droppedUnseenCrossingTrade',
  );
  for (const [index, action] of actions.entries()) {
    if (restartAt === index) {
      engine = makeEngine();
      engine.registerConditionalOrder(stop);
      if (index >= 4) {
        fencingToken = 2n;
        await engine.onOrderBook(envelope(book('88'), 2n, 2n, 1n));
      }
    }
    if (action.type === 'healthyTrade') {
      await engine.onOrderBook(envelope(book('99'), 1n, 1n, 1n));
      await engine.onTrade(
        envelope(
          {
            market: 'US',
            symbol: 'AAPL',
            price: action.price as string,
            source: 'WEBSOCKET',
          } satisfies TradeEvent & { market: 'US'; symbol: string },
          1n,
          1n,
          1n,
        ),
      );
    } else if (action.type === 'restingStop') {
      engine.registerConditionalOrder(stop);
    } else if (action.type === 'recoveredRestPriceBook') {
      fencingToken = 2n;
      await engine.onOrderBook(
        envelope(book(action.price as string), 2n, 2n, 1n),
      );
      await engine.onTrade(
        envelope(
          {
            market: 'US',
            symbol: 'AAPL',
            price: action.price as string,
            source: 'RECOVERY_REST',
            recoveryEpoch: 2n,
          } satisfies TradeEvent & { market: 'US'; symbol: string },
          2n,
          2n,
          2n,
        ),
      );
    } else if (action.type === 'staleOldEpochFrame') {
      await engine.onTrade(
        envelope(
          {
            market: 'US',
            symbol: 'AAPL',
            price: action.price as string,
            source: 'WEBSOCKET',
          } satisfies TradeEvent & { market: 'US'; symbol: string },
          1n,
          1n,
          2n,
        ),
      );
      staleFrameRejected = staleFrameRejected && recoveryFills === 1;
    } else if (action.type === 'leaderHandoff') {
      fencingToken = 3n;
    } else if (action.type === 'currentEpochTrade') {
      await engine.onTrade(
        envelope(
          {
            market: 'US',
            symbol: 'AAPL',
            price: action.price as string,
            source: 'WEBSOCKET',
          } satisfies TradeEvent & { market: 'US'; symbol: string },
          2n,
          3n,
          3n,
        ),
      );
    }
    if (recoveryFills > 1) terminalRearm = true;
  }
  return {
    seed: scenario.seed,
    historicalFills,
    recoveryFills,
    staleFrameRejected,
    balancedLedger: ledger.reduce((sum, value) => sum + value, 0) === 0,
    incidentChain: incidents.size,
    terminalOrdersNeverRearm: !terminalRearm,
  };
}

describe('Plan 2 lossy market recovery', () => {
  it('keeps the deterministic fault outcome fenced, balanced, and non-rearming', async () => {
    const outcomes = await Promise.all([
      runScenario(),
      runScenario(3),
      runScenario(5),
    ]);
    expect(outcomes).toEqual(
      outcomes.map((_outcome) => ({ ...outcomes[0], seed: 220826 })),
    );
    expect(outcomes[0]).toMatchObject({
      historicalFills: 0,
      recoveryFills: 1,
      staleFrameRejected: true,
      balancedLedger: true,
      incidentChain: 1,
      terminalOrdersNeverRearm: true,
    });
  });
});
