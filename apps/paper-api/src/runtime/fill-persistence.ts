import { randomUUID } from 'node:crypto';
import { DomainError, type Market } from '@moi/trading-core';
import { sql } from 'kysely';
import type { Database } from '../db/database.js';
import type { OrderMatch } from '../engine/match-orders.js';
import type { PaperOrder } from '../engine/paper-engine.js';
import type { PricingContext } from '../engine/pricing-context.js';
import { type FillFacts, fillRecord } from '../modules/portfolio/fill-schemas.js';
import { lockBalances, settleFill } from './fill-settlement.js';
import {
  allocateAccountSequence,
  runSessionTransaction,
} from './ledger-transaction.js';

type LogFn = (event: string, fields: Record<string, unknown>) => void;

type PersistedFill = FillFacts;

const TERMINAL_STATUSES = ['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'];

/**
 * Raised when the ledger already holds the order in a terminal state (a
 * cancellation committed first). The engine treats it as "drop this order",
 * not as a failure.
 */
export class OrderTerminalError extends Error {
  readonly code = 'ORDER_TERMINAL' as const;
  constructor(
    readonly orderId: string,
    readonly status: string,
  ) {
    super(`order ${orderId} is already ${status}`);
  }
}

export const isOrderTerminalError = (
  error: unknown,
): error is OrderTerminalError =>
  (error as { code?: unknown })?.code === 'ORDER_TERMINAL';

/**
 * Persists an engine fill in one transaction — order status, fills, ledger
 * settlement, audit, and the user-stream outbox row — taking ledger locks in
 * LEDGER_LOCK_ORDER (session → balance → order → reservation) so it can never
 * deadlock with a cancellation. The transaction refuses to commit when the
 * lease fencing token no longer matches `leader_epochs` (§7.1) or when the
 * order is already terminal.
 */
export function createFillPersistence(deps: {
  readonly db: Database;
  readonly log: LogFn;
  /** Published `fee_model_versions.id` the fill's fee was computed under. */
  readonly feeModelVersionId?: () => string | undefined;
  /** Fee the remaining quantity would cost; sizes the kept reservation. */
  readonly estimateFee?: (price: string, quantity: string) => string;
  readonly onTransaction?: <T>(work: () => Promise<T>) => Promise<T>;
}) {
  const wrap = deps.onTransaction ?? ((work) => work());
  return async function persistFill(
    order: PaperOrder,
    match: OrderMatch,
    pricing: PricingContext,
  ): Promise<void> {
    await wrap(() =>
      runSessionTransaction(deps.db, order.sessionId, async (trx) => {
        await lockBalances(trx, order);
        const row = (
          await sql<{ status: string; oco_group_id: string | null }>`
            select status, oco_group_id::text from orders where id = ${order.id}::uuid for update
          `.execute(trx)
        ).rows[0];
        if (row === undefined)
          throw new DomainError('INVALID_ORDER', 'filled order was not found');
        if (TERMINAL_STATUSES.includes(row.status))
          throw new OrderTerminalError(order.id, row.status);
        const fence = await sql<{ fencing_token: string }>`
          select fencing_token::text from leader_epochs where market_code = ${order.market as Market}
        `.execute(trx);
        const current = fence.rows[0]?.fencing_token;
        if (
          current === undefined ||
          BigInt(current) !== pricing.leaderFencingToken
        ) {
          throw new DomainError(
            'ORDER_STATE_CONFLICT',
            'fill rejected: stale leader fencing token',
          );
        }
        await sql`
          update orders
            set filled_quantity = ${match.filledQuantity}, status = ${match.nextStatus},
                terminal_reason = ${match.execution.terminalReason ?? null},
                market_data_epoch = ${pricing.recoveryEpoch}, updated_at = now(), version = version + 1
          where id = ${order.id}::uuid
        `.execute(trx);
        // The sequence is allocated before the rows so each fill can record the
        // ORDER_FILLED event it will be published in; a client can then align a
        // `GET /api/v1/fills` page with the account stream it was reading.
        const sequence = await allocateAccountSequence(
          trx,
          order.sessionId,
          'ORDER_FILLED',
        );
        const persisted: PersistedFill[] = [];
        for (const fill of match.execution.fills) {
          const inserted = await sql<{ id: string; fill_sequence: string }>`
            insert into fills (
              id, order_id, session_id, account_sequence, price, quantity, fee, slippage,
              reference_trade_price, recovery_epoch, market_data_version, leader_fencing_token,
              is_recovery_fill, fee_model_version_id
            ) values (
              ${randomUUID()}::uuid, ${order.id}::uuid, ${order.sessionId}::uuid, ${sequence},
              ${fill.price}, ${fill.quantity}, ${fill.fee},
              ${match.execution.slippageAmount}, ${pricing.referencePrice}, ${pricing.recoveryEpoch},
              ${pricing.marketDataVersion}, ${pricing.leaderFencingToken}, ${pricing.recoveryFill === true},
              ${deps.feeModelVersionId?.() ?? null}::uuid
            )
            returning id::text as id, fill_sequence::text as fill_sequence
          `.execute(trx);
          const row = inserted.rows[0];
          if (row === undefined)
            throw new DomainError(
              'INVARIANT_VIOLATION',
              'fill insert returned no row',
            );
          persisted.push({
            id: row.id,
            fillSequence: row.fill_sequence,
            price: fill.price,
            quantity: fill.quantity,
            fee: fill.fee,
          });
        }
        await settleFill(trx, {
          order: {
            id: order.id,
            sessionId: order.sessionId,
            market: order.market as Market,
            symbol: order.symbol,
            side: order.side,
            ocoGroupId: row.oco_group_id,
            type: order.type,
            limitPrice: order.limitPrice ?? null,
            quantity: order.quantity,
            filledQuantityAfter: match.filledQuantity,
          },
          fills: match.execution.fills,
          terminal:
            match.nextStatus === 'FILLED' || match.nextStatus === 'CANCELLED',
          ...(deps.estimateFee === undefined
            ? {}
            : { estimateFee: deps.estimateFee }),
        });
        const payload = {
          orderId: order.id,
          status: match.nextStatus,
          filledQuantity: match.filledQuantity,
          recoveryEpoch: pricing.recoveryEpoch.toString(),
          recoveryFill: pricing.recoveryFill === true,
          // Nested rather than spread: the publisher merges a portfolio
          // snapshot over this payload, and top-level `market` would be
          // overwritten by the snapshot's own `market` object.
          fills: persisted.map((fill) =>
            fillRecord(fill, {
              orderId: order.id,
              market: order.market,
              symbol: order.symbol,
              side: order.side,
              accountSequence: sequence,
              isRecoveryFill: pricing.recoveryFill === true,
            }),
          ),
        };
        await sql`
          insert into audit_events (id, session_reference, order_id, event_type, payload, occurred_at)
          values (${randomUUID()}::uuid, ${order.sessionId}, ${order.id}::uuid, 'ORDER_FILLED', ${JSON.stringify(payload)}::jsonb, now())
        `.execute(trx);
        await sql`
          insert into outbox_events (id, event_id, session_id, stream_sequence, event_type, payload)
          values (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${order.sessionId}::uuid, ${sequence}, 'ORDER_FILLED', ${JSON.stringify(payload)}::jsonb)
        `.execute(trx);
      }),
    ).catch((error: unknown) => {
      deps.log(
        isOrderTerminalError(error)
          ? 'engine.fill_superseded'
          : 'engine.fill_rejected',
        {
          orderId: order.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    });
  };
}
