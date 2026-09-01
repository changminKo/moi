import {
  createSmaCrossover,
  SMA_CROSSOVER_ID,
} from '@moi/strategy-sdk/strategies/sma-crossover';
import type { Strategy } from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';

/**
 * The strategy registry (design §0: "프레임워크부터 제대로 — 레지스트리").
 *
 * A registry of *factories*, not of instances. A `Strategy` holds the window it
 * has accumulated, so two configured entries of the same strategy must not be
 * the same object; asking the registry for one is asking it to make one.
 *
 * Phase A shipped exactly one strategy, so the map has one entry. The shape is
 * what matters here: adding `grid` in phase E is a line in this file, and the
 * configuration loader already validates parameters through whatever schema the
 * factory's product publishes.
 */

export type StrategyFactory = () => Strategy<unknown>;

export type StrategyRegistry = ReadonlyMap<string, StrategyFactory>;

export const DEFAULT_REGISTRY: StrategyRegistry = new Map<
  string,
  StrategyFactory
>([[SMA_CROSSOVER_ID, createSmaCrossover as StrategyFactory]]);

export function createStrategy(
  registry: StrategyRegistry,
  id: unknown,
): Strategy<unknown> {
  if (typeof id !== 'string') {
    throw new DomainError('INVALID_ORDER', 'a strategy id must be a string');
  }

  const factory = registry.get(id);

  if (factory === undefined) {
    throw new DomainError(
      'INVALID_ORDER',
      `unknown strategy ${id}; the registry holds ${[...registry.keys()].join(', ')}`,
    );
  }

  const strategy = factory();

  // A factory registered under one id that answers to another would make every
  // state file and every log line name the wrong strategy.
  if (strategy.id !== id) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `the registry entry ${id} produced a strategy that calls itself ${strategy.id}`,
    );
  }

  return strategy;
}
