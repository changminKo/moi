import { describe, expect, it } from 'vitest';
import {
  buildSubscriptionPlan,
  TOSS_SYMBOL_WHITELIST,
} from './subscription-plan.js';

const symbols = [...TOSS_SYMBOL_WHITELIST];

describe('buildSubscriptionPlan', () => {
  it('builds the fixed two-topic full replacement for forty US symbols', () => {
    const plan = buildSubscriptionPlan('US', symbols);
    expect(plan.topicCount).toBe(80);
    expect(plan.declaration).toEqual([
      { channel: 'trade', market: 'US', symbols },
      { channel: 'orderBook', market: 'US', symbols },
    ]);
  });
});
