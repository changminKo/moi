import { randomUUID } from 'node:crypto';
import { DomainError } from '@moi/trading-core';
import type {
  LockedPosition,
  LockedWallet,
} from '../db/repositories/account-repository.js';
import type { LockedOrder } from '../db/repositories/order-repository.js';
import type { UnitOfWork } from '../db/unit-of-work.js';

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface CancellationEngine {
  cancelOrder(id: string): Promise<unknown>;
}

export interface OrderCancellationDeps {
  readonly uow: Pick<UnitOfWork, 'run'>;
  readonly engines: () => Iterable<CancellationEngine>;
  readonly log: LogFn;
  readonly now?: () => Date;
}

export interface CancelCommand {
  readonly sessionId: string;
  readonly orderId: string;
}

export interface CancelResult {
  readonly id: string;
  readonly status: string;
  /** Every order the ledger transition cancelled (both legs for an OCO). */
  readonly cancelledOrderIds: readonly string[];
}

const TERMINAL = new Set(['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED']);

/**
 * Cancels an order (or, for an OCO leg, the whole bracket) in two strictly
 * separated steps:
 *
 *  1. One ledger transaction that walks LEDGER_LOCK_ORDER — session →
 *     wallet/position → OCO group → legs (ascending id) → reservation — and
 *     commits the CANCELLED status, group resolution, reservation release,
 *     audit and outbox rows. Reservation amounts are read under lock, so a
 *     partial fill that shrank the reservation is honoured, and the shared
 *     OCO reservation is released because every leg is terminal by then.
 *  2. Only after the commit, the engines drop the orders. No DB lock is ever
 *     held while awaiting the engine, so a fill callback queued behind this
 *     cancellation cannot form a cycle; if it later reaches the ledger it
 *     finds the terminal status and is rejected as superseded.
 */
export function createOrderCancellation(deps: OrderCancellationDeps) {
  const now = deps.now ?? (() => new Date());
  return async function cancelOrder(
    command: CancelCommand,
  ): Promise<CancelResult> {
    const result = await deps.uow.run(async (tx): Promise<CancelResult> => {
      const oco = await tx.orders.findOcoLegs(command.orderId);
      const candidates = await tx.accounts.findOrderReservations({
        sessionId: command.sessionId,
        orderId: command.orderId,
        wholeGroup: oco !== undefined,
      });
      const session = await tx.sessions.lock(command.sessionId);
      if (session === undefined || session.status !== 'ACTIVE')
        throw new DomainError(
          'ACCOUNT_READ_ONLY',
          'the session cannot accept cancellation',
        );
      // Balances are locked from the unlocked read's KEYS only (a currency or
      // symbol never changes); amounts are re-read under lock below.
      const wallets = new Map<string, LockedWallet>();
      const positions = new Map<string, LockedPosition>();
      for (const candidate of candidates) {
        if (candidate.kind === 'CASH' && candidate.currency !== null) {
          if (wallets.has(candidate.currency)) continue;
          const wallet = await tx.accounts.lockWallet({
            sessionId: command.sessionId,
            currency: candidate.currency,
          });
          if (wallet !== undefined) wallets.set(candidate.currency, wallet);
        } else if (candidate.marketCode !== null && candidate.symbol !== null) {
          const key = `${candidate.marketCode}:${candidate.symbol}`;
          if (positions.has(key)) continue;
          const position = await tx.accounts.lockPosition({
            sessionId: command.sessionId,
            marketCode: candidate.marketCode,
            symbol: candidate.symbol,
          });
          if (position !== undefined) positions.set(key, position);
        }
      }
      const group =
        oco === undefined
          ? undefined
          : await tx.orders.lockOcoGroup(oco.groupId);
      const legs = new Map<string, LockedOrder>();
      for (const legId of oco?.legIds ?? [command.orderId]) {
        const leg = await tx.orders.lock(legId);
        if (leg !== undefined) legs.set(legId, leg);
      }
      const order = legs.get(command.orderId);
      if (order === undefined || order.sessionId !== command.sessionId)
        throw new DomainError('INVALID_ORDER', 'order was not found');
      if (TERMINAL.has(order.status))
        return { id: order.id, status: order.status, cancelledOrderIds: [] };
      const cancelled: LockedOrder[] = [];
      for (const leg of legs.values()) {
        if (TERMINAL.has(leg.status)) continue;
        await tx.orders.update({
          id: leg.id,
          expectedVersion: leg.version,
          status: 'CANCELLED',
          ...(leg.filledQuantity === undefined
            ? {}
            : { filledQuantity: leg.filledQuantity }),
          ...(oco === undefined ? {} : { ocoGroupId: oco.groupId }),
        });
        cancelled.push(leg);
      }
      if (group !== undefined && group.status === 'ACTIVE')
        await tx.orders.resolveOcoGroup({
          id: group.id,
          expectedVersion: group.version,
          resolvedAt: now(),
        });
      for (const candidate of candidates) {
        const reservation = await tx.accounts.lockReservation(candidate.id);
        if (reservation === undefined || reservation.released) continue;
        if (reservation.kind === 'CASH' && candidate.currency !== null) {
          const wallet = wallets.get(candidate.currency);
          if (wallet === undefined)
            throw new DomainError(
              'INVARIANT_VIOLATION',
              `reservation ${reservation.id} has no ${candidate.currency} wallet to release into`,
            );
          const released = await tx.accounts.releaseCash({
            wallet,
            amount: reservation.amount,
            reservationId: reservation.id,
          });
          wallets.set(candidate.currency, {
            ...wallet,
            ...released,
            version: wallet.version + 1n,
          });
        } else if (candidate.marketCode !== null && candidate.symbol !== null) {
          const key = `${candidate.marketCode}:${candidate.symbol}`;
          const position = positions.get(key);
          if (position === undefined)
            throw new DomainError(
              'INVARIANT_VIOLATION',
              `reservation ${reservation.id} has no ${candidate.symbol} position to release into`,
            );
          const released = await tx.accounts.releasePosition({
            position,
            quantity: reservation.amount,
            reservationId: reservation.id,
          });
          positions.set(key, {
            ...position,
            ...released,
            version: position.version + 1n,
          });
        }
      }
      for (const leg of cancelled) {
        const payload =
          oco === undefined
            ? { orderId: leg.id }
            : {
                orderId: leg.id,
                ocoGroupId: oco.groupId,
                reason:
                  leg.id === command.orderId ? 'USER' : 'OCO_SIBLING_CANCELLED',
              };
        await tx.audit.append({
          id: randomUUID(),
          eventType: 'ORDER_CANCELLED',
          payload,
          occurredAt: now(),
          sessionReference: command.sessionId,
          orderId: leg.id,
        });
        const sequence = await tx.sequences.allocate({
          sessionId: command.sessionId,
          mutationKind: 'ORDER_CANCELLED',
        });
        await tx.outbox.append({
          id: randomUUID(),
          eventId: randomUUID(),
          sessionId: command.sessionId,
          streamSequence: sequence,
          eventType: 'ORDER_CANCELLED',
          payload,
        });
      }
      return {
        id: order.id,
        status: 'CANCELLED',
        cancelledOrderIds: cancelled.map((leg) => leg.id),
      };
    });
    // Committed. Now — and only now — the engines let go of the orders.
    for (const orderId of result.cancelledOrderIds) {
      for (const engine of deps.engines()) {
        await engine.cancelOrder(orderId).catch((error: unknown) => {
          deps.log('engine.cancel_failed', {
            orderId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
    return result;
  };
}
