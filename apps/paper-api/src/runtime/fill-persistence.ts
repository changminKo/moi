import { randomUUID } from 'node:crypto';
import { DomainError, type Market } from '@skipjack/trading-core';
import { sql } from 'kysely';
import type { Database } from '../db/database.js';
import type { OrderMatch } from '../engine/match-orders.js';
import type { PaperOrder } from '../engine/paper-engine.js';
import type { PricingContext } from '../engine/pricing-context.js';

type LogFn = (event: string, fields: Record<string, unknown>) => void;

/**
 * Persists an engine fill in one transaction: order status, fills, position,
 * audit, and the user-stream outbox row. The transaction refuses to commit
 * when the lease fencing token no longer matches `leader_epochs` (§7.1).
 */
export function createFillPersistence(deps: {
  readonly db: Database;
  readonly log: LogFn;
  readonly onTransaction?: <T>(work: () => Promise<T>) => Promise<T>;
}) {
  const wrap = deps.onTransaction ?? ((work) => work());
  return async function persistFill(
    order: PaperOrder,
    match: OrderMatch,
    pricing: PricingContext,
  ): Promise<void> {
    await wrap(() =>
      deps.db.transaction().execute(async (trx) => {
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
        for (const fill of match.execution.fills) {
          await sql`
            insert into fills (
              id, order_id, price, quantity, fee, slippage, reference_trade_price,
              recovery_epoch, market_data_version, leader_fencing_token, is_recovery_fill
            ) values (
              ${randomUUID()}::uuid, ${order.id}::uuid, ${fill.price}, ${fill.quantity}, ${fill.fee},
              ${match.execution.slippageAmount}, ${pricing.referencePrice}, ${pricing.recoveryEpoch},
              ${pricing.marketDataVersion}, ${pricing.leaderFencingToken}, ${pricing.recoveryFill === true}
            )
          `.execute(trx);
          if (order.side === 'BUY')
            await sql`
              insert into positions
                (id, session_id, market_code, symbol, total_quantity, available_quantity, reserved_quantity, average_cost)
              values (${randomUUID()}::uuid, ${order.sessionId}::uuid, ${order.market}, ${order.symbol}, ${fill.quantity}, ${fill.quantity}, 0, ${fill.price})
              on conflict (session_id, market_code, symbol) do update
                set total_quantity = positions.total_quantity + excluded.total_quantity,
                    available_quantity = positions.available_quantity + excluded.available_quantity,
                    version = positions.version + 1
            `.execute(trx);
        }
        const sequence = await sql<{ sequence: string }>`
          with next as (
            select coalesce(max(account_sequence), 0) + 1 as sequence
            from account_sequences where session_id = ${order.sessionId}::uuid
          )
          insert into account_sequences (id, session_id, account_sequence, mutation_kind)
          select ${randomUUID()}::uuid, ${order.sessionId}::uuid, sequence, 'ORDER_FILLED' from next
          returning account_sequence::text as sequence
        `.execute(trx);
        const payload = {
          orderId: order.id,
          status: match.nextStatus,
          filledQuantity: match.filledQuantity,
          recoveryEpoch: pricing.recoveryEpoch.toString(),
          recoveryFill: pricing.recoveryFill === true,
        };
        await sql`
          insert into audit_events (id, session_reference, order_id, event_type, payload, occurred_at)
          values (${randomUUID()}::uuid, ${order.sessionId}, ${order.id}::uuid, 'ORDER_FILLED', ${JSON.stringify(payload)}::jsonb, now())
        `.execute(trx);
        await sql`
          insert into outbox_events (id, event_id, session_id, stream_sequence, event_type, payload)
          values (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${order.sessionId}::uuid, ${sequence.rows[0]?.sequence ?? '1'}, 'ORDER_FILLED', ${JSON.stringify(payload)}::jsonb)
        `.execute(trx);
      }),
    ).catch((error: unknown) => {
      deps.log('engine.fill_rejected', {
        orderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  };
}
