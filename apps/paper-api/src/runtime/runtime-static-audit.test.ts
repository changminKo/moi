import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

/** §11.1 Codex verification items that are pure source-shape facts. */
describe('runtime static audit (§11.1)', () => {
  const runtime = read('./production-runtime.ts');
  const loop = read('../modules/stream/outbox-publisher-loop.ts');
  const lease = read('../market-data/leader-lease.ts');
  const registry = read('./lease-registry.ts');
  const state = read('./runtime-state.ts');
  const hub = read('../modules/stream/stream-hub.ts');
  const gate = read('./request-admission-gate.ts');
  const main = read('../main.ts');

  it('publisher.start() has exactly one call site: RuntimeStateMachine.enterServing', () => {
    expect(runtime.match(/publisher\.start\(/g) ?? []).toHaveLength(0);
    expect(state.match(/publisher\.start\(\)/g)).toHaveLength(1);
    const enterServing = state.slice(
      state.indexOf('enterServing(): void {'),
      state.indexOf('leaveServing('),
    );
    expect(enterServing).toContain('publisher.start()');
    expect(enterServing).not.toMatch(/\bawait\b/);
  });

  it('pauseScheduling() has exactly one call site inside leaveServing, with no await', () => {
    expect(runtime.match(/pauseScheduling\(/g) ?? []).toHaveLength(0);
    expect(state.match(/\.pauseScheduling\(\)/g)).toHaveLength(1);
    const leaveServing = state.slice(
      state.indexOf('leaveServing('),
      state.lastIndexOf('}'),
    );
    expect(leaveServing).not.toMatch(/\bawait\b/);
  });

  it('shutdownDrain() is called once, guarded by leftFrom === SERVING after awaiting pendingPoll', () => {
    const calls = runtime.match(/publisher\.shutdownDrain\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const drainOutbox = runtime.slice(
      runtime.indexOf('drainOutbox: async (until) => {'),
      runtime.indexOf('closeSockets: async () => {'),
    );
    expect(drainOutbox.indexOf('await pendingPoll')).toBeLessThan(
      drainOutbox.indexOf('shutdownDrain'),
    );
    expect(drainOutbox).toContain("leftFrom === 'SERVING'");
    const body = loop.slice(
      loop.indexOf('async shutdownDrain('),
      loop.indexOf('readonly #tick'),
    );
    expect(body).not.toMatch(/setTimeout|setInterval|running\s*=/);
  });

  it('the outbox loop never exposes stop()/drain() and never uses setInterval', () => {
    expect(loop).not.toMatch(/setInterval/);
    expect(loop).not.toMatch(/^\s+stop\(/m);
    expect(loop).not.toMatch(/^\s+drain\(/m);
  });

  it('LeaderLease uses only pg_try_advisory_lock polling and unlocks in finally', () => {
    expect(lease).not.toMatch(/pg_advisory_lock\(/);
    expect(lease).toMatch(/pg_try_advisory_lock\(/);
    expect(lease).toMatch(/pg_advisory_unlock\(/);
    const release = lease.slice(
      lease.indexOf('async release(): Promise<void> {'),
      lease.indexOf('#reportLost(): void {'),
    );
    expect(release).toContain("this.#state = 'RELEASING';");
    expect(release.indexOf("'RELEASING'")).toBeLessThan(
      release.indexOf('begin'),
    );
    expect(release).toMatch(/finally \{[\s\S]*pg_advisory_unlock/);
    expect(lease.match(/#reportLost\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('LeaseRegistry has no public per-market acquire and writes no audit rows', () => {
    expect(registry).not.toMatch(/^\s+acquire\(/m);
    expect(registry).toMatch(/acquireAll\(/);
    expect(registry).not.toMatch(/audit_events/);
    expect(
      read('./lease-audit.ts').match(/insert into audit_events/g),
    ).toHaveLength(1);
  });

  it('StreamGate is derived from the state machine, not a separate flag', () => {
    expect(state).toContain("isOpen: () => this.#current === 'SERVING'");
    expect(runtime).not.toMatch(/streamGateOpen|gateOpen\s*=/);
  });

  it('StreamHub registers before durable reads and flips to LIVE only on an observed empty queue', () => {
    const promote = hub.slice(
      hub.indexOf('async promoteToLive('),
      hub.indexOf('publishQuote('),
    );
    const liveAssignments = promote.match(/state = 'LIVE'/g) ?? [];
    expect(liveAssignments).toHaveLength(1);
    expect(promote.indexOf('queue.length === 0')).toBeLessThan(
      promote.indexOf("state = 'LIVE'"),
    );
    const upgrade = read('../modules/stream/stream-upgrade.ts');
    expect(upgrade.indexOf('hub.registerOpening(')).toBeLessThan(
      upgrade.indexOf('StreamSession.open('),
    );
  });

  it('RequestAdmissionGate closes before the admission latch in shutdown and settles in three hooks', () => {
    const stop = runtime.slice(
      runtime.indexOf('async #runStop('),
      runtime.indexOf('#buildMarket(market: Market): void'),
    );
    expect(stop.indexOf('leaveServing')).toBeLessThan(
      stop.indexOf('this.#gate.close()'),
    );
    expect(stop.indexOf('this.#gate.close()')).toBeLessThan(
      stop.indexOf('this.#gate.drain('),
    );
    for (const hook of ["'onResponse'", "'onError'", "'onRequestAbort'"])
      expect(gate).toContain(`addHook(${hook}`);
    expect(gate.match(/^\s+settle\(request\);/gm)?.length).toBe(3);
  });

  it('main.ts only assembles config → bundle → runtime', () => {
    const main = read('../main.ts');
    expect(main).toContain('loadConfig(environment)');
    expect(main).toContain('createProviderBundle(config)');
    expect(main).toContain('new ProductionRuntime(');
    expect(main).not.toMatch(
      /cancelOnly|placeImmediateOrder|registerHealthRoutes/,
    );
  });

  it('main.ts builds the runtime without the test-only database seam', () => {
    // `ProductionRuntimeOptions.database` exists so a test can hold one of the
    // pool's clients; production always builds its own from DATABASE_URL.
    const construction = main.slice(
      main.indexOf('new ProductionRuntime({'),
      main.indexOf('});', main.indexOf('new ProductionRuntime({')),
    );
    expect(construction).not.toMatch(/\bdatabase\s*[:,]/);
  });
});
