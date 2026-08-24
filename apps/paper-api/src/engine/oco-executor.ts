import { DomainError } from '@skipjack/trading-core';
import { chooseRecoveryLeg } from './conditional-trigger.js';
import type { PricingContext } from './pricing-context.js';

export interface OcoGroupState { readonly legs: readonly [string, string]; status: 'ACTIVE' | 'RESOLVED'; winnerLegId?: string; }
export interface OcoTriggerContext extends Partial<PricingContext> { readonly bothConditionsTrue?: boolean; readonly stopLegId?: string; readonly takeProfitLegId?: string; }
export interface OcoExecutionInput { readonly groupId: string; readonly legId: string; readonly siblingId: string; readonly pricingContext: OcoTriggerContext; }
export interface OcoExecutorOptions {
  readonly groups: Map<string, OcoGroupState>;
  /** Called after the group parent has been acquired; implementations may lock it in UnitOfWork. */
  readonly acquireParent?: (groupId: string) => Promise<void>;
  /** Must contain winner transition, sibling cancellation, fill, audit and outbox in one transaction. */
  readonly execute: (input: OcoExecutionInput) => Promise<void>;
  readonly onReservationRelease?: (groupId: string) => Promise<void>;
  readonly isMarketOpen?: (context: OcoTriggerContext) => boolean;
}

/** OCO arbitration. The per-group chain models the parent-row lock for in-memory callers. */
export class OcoExecutor {
  readonly #options: OcoExecutorOptions;
  readonly #chains = new Map<string, Promise<unknown>>();
  constructor(options: OcoExecutorOptions) { this.#options = options; }
  group(groupId: string): OcoGroupState | undefined { return this.#options.groups.get(groupId); }

  async trigger(groupId: string, legId: string, pricingContext: OcoTriggerContext): Promise<boolean> {
    const previous = this.#chains.get(groupId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#chains.set(groupId, current);
    await previous;
    try {
      if (pricingContext.source === 'RECOVERY_REST' && this.#options.isMarketOpen?.(pricingContext) === false) return false;
      const group = this.#options.groups.get(groupId);
      if (group === undefined || group.status !== 'ACTIVE') return false;
      const [first, second] = group.legs;
      if (legId !== first && legId !== second) throw new DomainError('ORDER_STATE_CONFLICT', 'Leg is not in OCO group');
      let winner = legId;
      if (pricingContext.source === 'RECOVERY_REST' && pricingContext.bothConditionsTrue === true) {
        winner = chooseRecoveryLeg(pricingContext.stopLegId ?? first, pricingContext.takeProfitLegId ?? second, true, legId);
      }
      const siblingId = winner === first ? second : first;
      await this.#options.acquireParent?.(groupId);
      await this.#options.execute({ groupId, legId: winner, siblingId, pricingContext });
      group.status = 'RESOLVED';
      group.winnerLegId = winner;
      await this.#options.onReservationRelease?.(groupId);
      return true;
    } finally { release(); if (this.#chains.get(groupId) === current) this.#chains.delete(groupId); }
  }
}
