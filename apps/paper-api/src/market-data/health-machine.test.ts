import { describe, expect, it, vi } from 'vitest';
import { MarketHealthMachine } from './health-machine.js';
describe('MarketHealthMachine', () => {
  it('creates one cancel-only incident after close or two missed pongs', async () => {
    const activate = vi.fn(async () => ({ incidentId: 'i', version: 1n }));
    const machine = new MarketHealthMachine({ market: 'US', incidents: { activate } });
    await machine.onPong(false); await machine.onPong(false); await machine.onClose();
    expect(machine.state).toBe('DEGRADED'); expect(activate).toHaveBeenCalledTimes(1);
  });
  it('recovers only with a matching CAS incident resolution', async () => {
    const resolveCas = vi.fn(async () => true);
    const machine = new MarketHealthMachine({ market: 'KR', incidents: { activate: async () => ({ incidentId: 'i', version: 1n }), resolveCas } });
    await machine.onClose(); machine.beginRecovery(); expect(machine.state).toBe('RECOVERING'); await machine.markHealthy(2n); expect(machine.state).toBe('HEALTHY');
  });
});
