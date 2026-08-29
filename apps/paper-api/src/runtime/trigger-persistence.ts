import { randomUUID } from 'node:crypto';
import { DomainError, type FeeModel, type Market } from '@moi/trading-core';
import { sql } from 'kysely';
import type { Database } from '../db/database.js';
import type { ConditionalPaperOrder } from '../engine/paper-engine.js';
import type { PricingContext } from '../engine/pricing-context.js';
import { settleFill } from './fill-settlement.js';
import {
  allocateAccountSequence,
  runSessionTransaction,
} from './ledger-transaction.js';

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface TriggerPersistenceDeps {
  readonly db: Database;
  readonly feeModelFor: (market: Market) => FeeModel;
  readonly log: LogFn;
  readonly onTransaction?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * Persists a STOP / TAKE_PROFIT trigger (single or OCO leg) as one
 * transaction: the triggered order fills in full at the reference price, an
 * OCO sibling is cancelled and its group resolved with the shared reservation
 * released, and the fill, position, audit, and user-stream outbox rows are
 * written together. The lease fencing token is re-checked inside the
 * transaction (§7.1), so a stale leader's trigger can never commit.
 */
export function createTriggerPersistence(deps: TriggerPersistenceDeps) {
  const wrap = deps.onTransaction ?? ((work) => work());
  return async function persistTrigger(
    order: ConditionalPaperOrder,
    pricing: PricingContext,
  ): Promise<void> {
    await wrap(() =>
      runSessionTransaction(deps.db, order.sessionId, async (trx) => {
        const fence = await sql<{ fencing_token: string }>`
          select fencing_token::text from leader_epochs where market_code = ${order.market}
        `.execute(trx);
        const current = fence.rows[0]?.fencing_token;
        if (
          current === undefined ||
          BigInt(current) !== pricing.leaderFencingToken
        )
          throw new DomainError(
            'ORDER_STATE_CONFLICT',
            'trigger rejected: stale leader fencing token',
          );

        const row = (
          await sql<{
            oco_group_id: string | null;
            status: string;
            quantity: string;
          }>`
            select oco_group_id::text, status, quantity::text from orders where id = ${order.id}::uuid for update
          `.execute(trx)
        ).rows[0];
        if (row === undefined)
          throw new DomainError(
            'INVALID_ORDER',
            'triggered order was not found',
          );
        if (['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(row.status))
          return;

        const price = pricing.referencePrice;
        const quantity = row.quantity;
        const fee = deps.feeModelFor(order.market).calculate({
          market: order.market,
          side: order.side,
          price,
          quantity,
        });
        await sql`
          update orders
            set status = 'FILLED', filled_quantity = quantity, is_oco_winner = (oco_group_id is not null),
                market_data_epoch = ${pricing.recoveryEpoch}, updated_at = now(), version = version + 1
          where id = ${order.id}::uuid
        `.execute(trx);
        await sql`
          insert into fills (
            id, order_id, price, quantity, fee, slippage, reference_trade_price,
            recovery_epoch, market_data_version, leader_fencing_token, is_recovery_fill
          ) values (
            ${randomUUID()}::uuid, ${order.id}::uuid, ${price}, ${quantity}, ${fee}, 0, ${price},
            ${pricing.recoveryEpoch}, ${pricing.marketDataVersion}, ${pricing.leaderFencingToken}, ${pricing.recoveryFill === true}
          )
        `.execute(trx);
        await settleFill(trx, {
          order: {
            id: order.id,
            sessionId: order.sessionId,
            market: order.market,
            symbol: order.symbol,
            side: order.side,
            ocoGroupId: row.oco_group_id,
          },
          fills: [{ price, quantity, fee }],
          terminal: true,
        });
        const events: {
          type: string;
          payload: Record<string, unknown>;
          orderId: string;
        }[] = [
          {
            type: 'ORDER_FILLED',
            orderId: order.id,
            payload: {
              orderId: order.id,
              status: 'FILLED',
              filledQuantity: quantity,
              price,
              trigger: order.type,
              recoveryEpoch: pricing.recoveryEpoch.toString(),
              recoveryFill: pricing.recoveryFill === true,
            },
          },
        ];
        if (row.oco_group_id !== null) {
          const siblings = await sql<{ id: string }>`
            update orders set status = 'CANCELLED', updated_at = now(), version = version + 1
            where oco_group_id = ${row.oco_group_id}::uuid and id <> ${order.id}::uuid
              and status not in ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')
            returning id::text
          `.execute(trx);
          for (const sibling of siblings.rows)
            events.push({
              type: 'ORDER_CANCELLED',
              orderId: sibling.id,
              payload: { orderId: sibling.id, reason: 'OCO_SIBLING_FILLED' },
            });
          await sql`
            update oco_groups set status = 'RESOLVED', resolved_at = now(), version = version + 1
            where id = ${row.oco_group_id}::uuid and status = 'ACTIVE'
          `.execute(trx);
          events.push({
            type: 'OCO_RESOLVED',
            orderId: order.id,
            payload: { groupId: row.oco_group_id, winnerOrderId: order.id },
          });
        }

        for (const event of events) {
          await sql`
            insert into audit_events (id, session_reference, order_id, event_type, payload, occurred_at)
            values (${randomUUID()}::uuid, ${order.sessionId}, ${event.orderId}::uuid, ${event.type}, ${JSON.stringify(event.payload)}::jsonb, now())
          `.execute(trx);
          const sequence = await allocateAccountSequence(
            trx,
            order.sessionId,
            event.type,
          );
          await sql`
            insert into outbox_events (id, event_id, session_id, stream_sequence, event_type, payload)
            values (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${order.sessionId}::uuid, ${sequence}, ${event.type}, ${JSON.stringify(event.payload)}::jsonb)
          `.execute(trx);
        }
      }),
    ).catch((error: unknown) => {
      deps.log('engine.trigger_rejected', {
        orderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  };
}
