import { describe, expect, it } from 'vitest';
import { OcoExecutor } from './oco-executor.js';

describe('OcoExecutor', () => {
  it('allows exactly one winner and cancels its sibling during a concurrent race', async () => {
    const effects: string[] = [];
    const executor = new OcoExecutor({
      groups: new Map([['g', { legs: ['stop', 'take'], status: 'ACTIVE' }]]),
      acquireParent: async () => undefined,
      execute: async ({ legId, siblingId }) => { effects.push(`win:${legId}`); effects.push(`cancel:${siblingId}`); },
      onReservationRelease: async () => { effects.push('release'); },
    });
    await Promise.allSettled([
      executor.trigger('g', 'stop', { source: 'WEBSOCKET' }),
      executor.trigger('g', 'take', { source: 'WEBSOCKET' }),
    ]);
    expect(effects.filter((x) => x.startsWith('win:'))).toHaveLength(1);
    expect(effects.filter((x) => x.startsWith('cancel:'))).toHaveLength(1);
    expect(effects.filter((x) => x === 'release')).toHaveLength(1);
    expect(executor.group('g')?.status).toBe('RESOLVED');
  });

  it('chooses stop first when recovery conditions are both true', async () => {
    const winners: string[] = [];
    const executor = new OcoExecutor({
      groups: new Map([['g', { legs: ['stop', 'take'], status: 'ACTIVE' }]]),
      acquireParent: async () => undefined,
      execute: async ({ legId }) => { winners.push(legId); },
    });
    await executor.trigger('g', 'take', { source: 'RECOVERY_REST', bothConditionsTrue: true, stopLegId: 'stop' });
    expect(winners).toEqual(['stop']);
  });
});
