import { describe, expect, it, vi } from 'vitest';
import { MarketHealthMachine } from './health-machine.js';

describe('MarketHealthMachine', () => {
  it('creates one cancel-only incident after close or two missed pongs', async () => {
    const activate = vi.fn(async () => ({ incidentId: 'i', version: 1n }));
    const machine = new MarketHealthMachine({
      market: 'US',
      incidents: { activate },
    });
    await machine.onPong(false);
    await machine.onPong(false);
    await machine.onClose();
    expect(machine.state).toBe('DEGRADED');
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it('recovers only with a matching CAS incident resolution', async () => {
    const resolveCas = vi.fn(async () => true);
    const machine = new MarketHealthMachine({
      market: 'KR',
      incidents: {
        activate: async () => ({ incidentId: 'i', version: 1n }),
        resolveCas,
      },
    });
    await machine.onClose();
    machine.beginRecovery();
    expect(machine.state).toBe('RECOVERING');
    await machine.markHealthy(2n);
    expect(machine.state).toBe('HEALTHY');
  });
  it('joins a racing second degrade instead of orphaning the first incident', async () => {
    // The keepalive ping and the event loop can both degrade the same market
    // in the same tick; the check-then-activate window used to open two rows
    // and remember only one.
    let opened = 0;
    const activate = vi.fn(async () => {
      opened += 1;
      const incidentId = `i-${opened}`;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { incidentId, version: 1n };
    });
    const machine = new MarketHealthMachine({
      market: 'US',
      incidents: { activate },
    });
    await Promise.all([
      machine.onClose('TRANSPORT_CLOSED'),
      machine.onClose('EVENT_LOOP_FAILED'),
    ]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(machine.incidentId).toBe('i-1');
  });
  it('resolves the incidents a previous process left ACTIVE for this market', async () => {
    // A restart gives the market a fresh machine with an empty slot while the
    // ledger still holds the rows placement is derived from.
    const resolveMarketIncidents = vi.fn(async () => [] as readonly string[]);
    const machine = new MarketHealthMachine({
      market: 'US',
      incidents: {
        activate: async () => ({ incidentId: 'i', version: 1n }),
        resolveMarketIncidents,
      },
    });
    expect(machine.incidentId).toBeUndefined();
    expect(await machine.markHealthy(7n)).toBe(true);
    expect(resolveMarketIncidents).toHaveBeenCalledWith({
      market: 'US',
      recoveryEpoch: 7n,
    });
    expect(machine.state).toBe('HEALTHY');
  });
  it('reports what a recovery could not clear without holding the feed DEGRADED', async () => {
    const machine = new MarketHealthMachine({
      market: 'KR',
      incidents: {
        activate: async () => ({ incidentId: 'i', version: 1n }),
        resolveMarketIncidents: async () => [
          'STARTUP_INVARIANT_OR_AUDIT_FAILURE',
        ],
      },
    });
    await machine.onClose();
    expect(machine.state).toBe('DEGRADED');
    // The feed is demonstrably back, so pong handling must not keep closing
    // the transport; the surviving block is reported to the caller instead.
    expect(await machine.markHealthy(2n)).toBe(false);
    expect(machine.state).toBe('HEALTHY');
    expect(machine.incidentId).toBeUndefined();
  });
});
