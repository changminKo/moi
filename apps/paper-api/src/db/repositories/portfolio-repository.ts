import { sql } from 'kysely';
import type {
  HistoricalOrdersPage,
  PortfolioQuery,
  PortfolioSnapshot,
} from '../../modules/portfolio/portfolio-schemas.js';
import type { PortfolioReadTransaction } from '../../modules/portfolio/portfolio-service.js';
import type { LedgerConnection } from '../unit-of-work.js';

type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value);
const nullable = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const encodeCursor = (createdAt: unknown, id: unknown): string =>
  Buffer.from(`${text(createdAt)}\n${text(id)}`, 'utf8').toString('base64url');
const decodeCursor = (cursor: string): readonly [string, string] => {
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  const split = value.indexOf('\n');
  if (split <= 0 || split === value.length - 1)
    throw new Error('invalid order cursor');
  return [value.slice(0, split), value.slice(split + 1)];
};

function order(row: Row): Record<string, string | null> {
  return {
    id: text(row.id),
    market: text(row.market_code),
    symbol: text(row.symbol),
    type: text(row.order_type),
    side: text(row.side),
    quantity: text(row.quantity),
    filledQuantity: text(row.filled_quantity),
    status: text(row.status),
    limitPrice: nullable(row.limit_price),
    stopPrice: nullable(row.stop_price),
    terminalReason: nullable(row.terminal_reason),
  };
}

export interface PortfolioReadRepository extends PortfolioReadTransaction {}

export const createPortfolioRepository = (
  connection: LedgerConnection,
): PortfolioReadRepository => ({
  async snapshot(sessionId) {
    const [
      wallets,
      positions,
      reservations,
      activeOrders,
      sequence,
      markets,
      recovery,
    ] = await Promise.all([
      sql<Row>`select currency, total, available, reserved from wallets where session_id = ${sessionId} order by currency`.execute(
        connection.executor,
      ),
      sql<Row>`select market_code, symbol, total_quantity, available_quantity, reserved_quantity, average_cost from positions where session_id = ${sessionId} order by market_code, symbol`.execute(
        connection.executor,
      ),
      sql<Row>`select id, order_id, oco_group_id, kind, currency, market_code, symbol, amount, released from reservations where session_id = ${sessionId} and not released order by id`.execute(
        connection.executor,
      ),
      sql<Row>`select id, market_code, symbol, order_type, side, quantity, filled_quantity, status, limit_price, stop_price, terminal_reason from orders where session_id = ${sessionId} and status in ('RECEIVED','PENDING_TRIGGER','TRIGGERED','OPEN','PARTIALLY_FILLED') order by created_at, id`.execute(
        connection.executor,
      ),
      sql<Row>`select coalesce(max(account_sequence), 0) as account_sequence from account_sequences where session_id = ${sessionId}`.execute(
        connection.executor,
      ),
      sql<Row>`select market_code, health_state from market_states where symbol is null order by market_code`.execute(
        connection.executor,
      ),
      sql<Row>`select distinct on (o.market_code) o.market_code, f.is_recovery_fill from orders o join fills f on f.order_id = o.id where o.session_id = ${sessionId} order by o.market_code, f.occurred_at desc`.execute(
        connection.executor,
      ),
    ]);
    const health: Record<string, string> = {
      KR: 'UNAVAILABLE',
      US: 'UNAVAILABLE',
    };
    for (const row of markets.rows)
      health[text(row.market_code)] = text(row.health_state);
    const recoveryFill: Record<string, boolean> = { KR: false, US: false };
    for (const row of recovery.rows)
      recoveryFill[text(row.market_code)] = row.is_recovery_fill === true;
    return {
      wallets: wallets.rows.map((row) => ({
        currency: text(row.currency),
        total: text(row.total),
        available: text(row.available),
        reserved: text(row.reserved),
      })),
      positions: positions.rows.map((row) => ({
        market: text(row.market_code),
        symbol: text(row.symbol),
        total: text(row.total_quantity),
        available: text(row.available_quantity),
        reserved: text(row.reserved_quantity),
        averageCost: text(row.average_cost),
      })),
      reservations: reservations.rows.map((row) => ({
        id: text(row.id),
        orderId: nullable(row.order_id),
        ocoGroupId: nullable(row.oco_group_id),
        kind: text(row.kind),
        currency: nullable(row.currency),
        market: nullable(row.market_code),
        symbol: nullable(row.symbol),
        amount: text(row.amount),
        released: row.released === true,
      })),
      activeOrders: activeOrders.rows.map(order),
      accountSequence: text(sequence.rows[0]?.account_sequence ?? '0'),
      market: { health, recoveryFill },
    } satisfies PortfolioSnapshot;
  },
  async listOrders(
    sessionId,
    query: PortfolioQuery,
  ): Promise<HistoricalOrdersPage> {
    const limit = query.limit;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const result =
      cursor === undefined
        ? await sql<Row>`select id, market_code, symbol, order_type, side, quantity, filled_quantity, status, limit_price, stop_price, terminal_reason, created_at from orders where session_id = ${sessionId} order by created_at desc, id desc limit ${limit + 1}`.execute(
            connection.executor,
          )
        : await sql<Row>`select id, market_code, symbol, order_type, side, quantity, filled_quantity, status, limit_price, stop_price, terminal_reason, created_at from orders where session_id = ${sessionId} and (created_at, id) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid) order by created_at desc, id desc limit ${limit + 1}`.execute(
            connection.executor,
          );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(order),
      ...(result.rows.length > limit
        ? {
            nextCursor: encodeCursor(
              rows[rows.length - 1]?.created_at,
              rows[rows.length - 1]?.id,
            ),
          }
        : {}),
    };
  },
  async getOrder(sessionId, orderId) {
    const result =
      await sql<Row>`select id, market_code, symbol, order_type, side, quantity, filled_quantity, status, limit_price, stop_price, terminal_reason from orders where session_id = ${sessionId} and id = ${orderId}`.execute(
        connection.executor,
      );
    const row = result.rows[0];
    return row === undefined ? undefined : order(row);
  },
});
