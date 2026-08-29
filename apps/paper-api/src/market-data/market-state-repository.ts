import { randomUUID } from 'node:crypto';
import type { Market } from '@moi/trading-core';
import { sql } from 'kysely';
import type { Database } from '../db/database.js';

export interface PersistedMarketState<T = unknown> {
  readonly market: Market;
  readonly symbol: string | null;
  readonly healthState: string;
  readonly recoveryEpoch: bigint;
  readonly marketDataVersion: bigint;
  readonly payload: T | null;
}

export interface MarketStateRepository {
  load(
    market: Market,
    symbol: string | null,
  ): Promise<PersistedMarketState | null>;
  save(state: PersistedMarketState): Promise<void>;
}

export const createMarketStateRepository = (
  db: Database,
): MarketStateRepository => ({
  async load(market, symbol) {
    const result = await sql<
      Record<string, unknown>
    >`select market_code, symbol, health_state, recovery_epoch, market_data_version from market_states where market_code = ${market} and coalesce(symbol, '') = coalesce(${symbol}, '')`.execute(
      db,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      market,
      symbol,
      healthState: String(row.health_state),
      recoveryEpoch: BigInt(String(row.recovery_epoch)),
      marketDataVersion: BigInt(String(row.market_data_version)),
      payload: null,
    };
  },
  async save(state) {
    await sql`insert into market_states (id, market_code, symbol, health_state, recovery_epoch, market_data_version) values (${randomUUID()}, ${state.market}, ${state.symbol}, ${state.healthState}, ${state.recoveryEpoch}, ${state.marketDataVersion}) on conflict (market_code, coalesce(symbol, '')) do update set health_state = excluded.health_state, recovery_epoch = excluded.recovery_epoch, market_data_version = excluded.market_data_version, observed_at = now(), version = market_states.version + 1`.execute(
      db,
    );
  },
});
