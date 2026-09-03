import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiProcess,
  type DrillClient,
  StreamCollector,
  sleep,
  TwoProcessHarness,
  waitUntil,
} from './testing/two-process-harness.js';

const DRILL_TIMEOUT_MS = 180_000;
const harness = new TwoProcessHarness();
const evidence: Record<string, unknown> = {};

beforeAll(async () => {
  await harness.start();
}, 300_000);

afterEach((context) => {
  // A failed step is evidence too: keep its assertion text next to the
  // process logs so an intermittent failure can be diagnosed after the fact.
  const errors = context.task.result?.errors ?? [];
  if (errors.length > 0)
    evidence.failure = {
      test: context.task.name,
      errors: errors.map((error) => error.message),
    };
});

afterAll(async () => {
  const file = harness.writeEvidence('drill', evidence);
  // eslint-disable-next-line no-console
  console.log(`[leader-handoff] evidence written to ${file}`);
  await harness.dispose();
});

const reasons = (trading: Record<string, unknown>): string[] =>
  (trading.reasons as string[]) ?? [];
const marketOrder = (market: 'KR' | 'US', symbol: string) => ({
  market,
  symbol,
  side: 'BUY',
  type: 'MARKET',
  quantity: '1',
});
const limitOrder = (
  market: 'KR' | 'US',
  symbol: string,
  limitPrice: string,
) => ({
  market,
  symbol,
  side: 'BUY',
  type: 'LIMIT',
  quantity: '1',
  limitPrice,
});

async function bootToServing(name: string): Promise<ApiProcess> {
  const api = await harness.spawn(name);
  await harness.waitForLive(api);
  await harness.waitForNormal(api, 20_000);
  return api;
}

function emitBooks(): void {
  harness.ws.emitOrderBook({
    market: 'US',
    symbol: 'AAPL',
    book: {
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      asks: [{ price: '190.30', volume: '100' }],
      bids: [{ price: '190.20', volume: '100' }],
    },
    sourceTimestamp: new Date().toISOString(),
  });
}

describe('graceful leader handoff drill (§10.2)', () => {
  it(
    'runs steps 1–11 with two real API processes and a loopback fake provider',
    async () => {
      // ---- 1. P1 boots to NORMAL --------------------------------------------
      const p1 = await bootToServing('P1');
      expect(reasons(await harness.trading(p1))).toEqual([]);
      expect((await harness.trading(p1)).placement).toBe(true);
      expect(harness.ws.connections).toBe(2);
      let epochs = await harness.leaderEpochs();
      expect(epochs.KR?.epoch).toBe('1');
      expect(epochs.US?.epoch).toBe('1');
      const p1Leader = p1.leaderId;

      // ---- 2. session, one MARKET fill delivered over the user stream, one open LIMIT
      const client: DrillClient = await harness.bootstrap(p1);
      const collector = new StreamCollector();
      expect((await collector.connect(p1.origin, client, 'P1')).status).toBe(
        101,
      );
      emitBooks();
      await sleep(200);
      const funded = await harness.fundUsd(p1, client);
      expect(funded.status, JSON.stringify(funded.body)).toBeLessThan(300);
      const filled = await harness.placeOrder(
        p1,
        client,
        marketOrder('US', 'AAPL'),
      );
      expect(filled.status, JSON.stringify(filled.body)).toBeLessThan(300);
      await waitUntil(
        () =>
          collector.uniqueEvents().some((e) => e.eventType === 'ORDER_FILLED'),
        10_000,
        'fill event over P1 stream',
      );
      const limit = await harness.placeOrder(
        p1,
        client,
        limitOrder('US', 'AAPL', '150.00'),
      );
      expect(limit.status, JSON.stringify(limit.body)).toBeLessThan(300);
      const limitId = String(
        (limit.body as { id?: string; order?: { id?: string } }).id ??
          (limit.body as { order?: { id?: string } }).order?.id,
      );
      expect(limitId).toMatch(/[0-9a-f-]{36}/);
      evidence.step2 = { filled: filled.body, limit: limit.body };

      // ---- 3. P2 boots and waits for the bundle ------------------------------
      const restBeforeP2 = harness.rest.requests().length;
      const p2 = await harness.spawn('P2');
      await harness.waitForLive(p2, 10_000);
      await waitUntil(
        async () =>
          reasons(await harness.trading(p2)).includes('ACQUIRING_LEASES'),
        5_000,
        'P2 ACQUIRING_LEASES',
      );
      expect((await harness.ready(p2)).status).toBe(200);
      expect(reasons(await harness.trading(p2))).toEqual(
        expect.arrayContaining(['CANCEL_ONLY', 'ACQUIRING_LEASES']),
      );
      expect(harness.ws.connections).toBe(2);
      expect(harness.ws.peakConcurrentConnections).toBe(2);
      expect(harness.rest.requests().length).toBe(restBeforeP2);
      expect(p2.events('outbox.poll')).toHaveLength(0);
      expect(
        (await collector.connect(p2.origin, client, 'P2-early')).status,
      ).toBe(503);
      await waitUntil(
        () => p2.events('lease.waiting').some((l) => l.fields.market === 'KR'),
        3_000,
        'P2 lease.waiting KR',
      );
      expect(
        p2.events('lease.waiting').some((l) => l.fields.market === 'US'),
      ).toBe(false);

      // ---- 4. SIGTERM P1: drain fences HTTP, P2 serves cancellation ----------
      // P1 drains an empty outbox in ~30 ms and exits ~60 ms after SIGTERM
      // (measured across twelve CI runs, passing and failing alike), so the
      // probes below cannot race the signal: on a loaded runner the first
      // poll lands before the state flips and the next one after the process
      // is gone (#65: `timed out waiting for P1 DRAINING`, `fetch failed`).
      // Instead one admitted request is pinned inside P1 — a cancellation
      // from a second session whose row the harness holds locked — and
      // §6.6-3 keeps P1 in DRAINING until that request is released. The
      // session is separate so P2's cancellation of the LIMIT below is not
      // blocked by the same lock.
      const holdClient = await harness.bootstrap(p1);
      await harness.holdSession(holdClient);
      const heldCancel = harness.cancelOrder(p1, holdClient, randomUUID());
      await waitUntil(
        async () =>
          (await harness.backendsBlockedOn('anonymous_sessions')) >= 1,
        5_000,
        'P1 admitted request blocked on the held session row',
      );
      const signalledAt = Date.now();
      const p1Exit = harness.stop(p1);
      await waitUntil(
        async () =>
          reasons(await harness.trading(p1).catch(() => ({}))).includes(
            'DRAINING',
          ),
        1_000,
        'P1 DRAINING',
      );
      evidence.step4DrainingObservedMs = Date.now() - signalledAt;
      const drainingReady = await harness.ready(p1);
      expect(drainingReady.status).toBe(503);
      expect(
        (drainingReady.body.details as { draining?: boolean } | undefined)
          ?.draining,
      ).toBe(true);
      expect((await fetch(`${p1.origin}/health/live`)).status).toBe(200);
      const rejectedPlace = await harness.placeOrder(
        p1,
        client,
        marketOrder('US', 'AAPL'),
      );
      expect(rejectedPlace.status).toBe(503);
      expect(rejectedPlace.body.code).toBe('NOT_READY');
      expect(rejectedPlace.headers.get('retry-after')).toBe('1');
      const rejectedCancel = await harness.cancelOrder(p1, client, limitId);
      expect(rejectedCancel.status).toBe(503);
      const cancelled = await harness.cancelOrder(p2, client, limitId);
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBeLessThan(
        300,
      );
      const blocked = await harness.placeOrder(
        p2,
        client,
        marketOrder('US', 'AAPL'),
      );
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('CANCEL_ONLY');
      // Every step-4 observation was made while P1 was pinned in DRAINING.
      expect(reasons(await harness.trading(p1))).toContain('DRAINING');
      // Let the admitted request finish: it was admitted before the gate
      // closed, so it completes (§6.6-3 "이미 허용된 요청만 drain") — with an
      // unknown order it ends as INVALID_ORDER and touches no ledger row.
      await harness.releaseSession();
      const held = await heldCancel;
      expect(held.status).toBe(400);
      expect(held.body.code).toBe('INVALID_ORDER');
      evidence.step4Held = { status: held.status, code: held.body.code };

      // ---- 5. P1 exits cleanly with lease audits before P2 acquires ----------
      const exit = await p1Exit;
      expect(exit.code).toBe(0);
      expect(exit.ms).toBeLessThan(15_000);
      const pendingAtExit = await harness.pendingOutbox();
      expect(pendingAtExit.length).toBeLessThanOrEqual(1);
      const p1Polls = p1.logs.filter(
        (l) =>
          l.event === 'outbox.poll' ||
          l.event === 'outbox.drain' ||
          (l.event === 'runtime.state' && l.fields.to === 'DRAINING'),
      );
      const drainingIndex = p1Polls.findIndex(
        (l) => l.event === 'runtime.state',
      );
      const afterDraining = p1Polls.slice(drainingIndex + 1);
      const periodicTail = afterDraining.filter(
        (l) => l.event === 'outbox.poll' && l.fields.mode === 'periodic',
      );
      expect(periodicTail.length).toBeLessThanOrEqual(1);
      const shutdownPolls = afterDraining.filter(
        (l) => l.event === 'outbox.poll' && l.fields.mode === 'shutdown_drain',
      );
      expect(shutdownPolls.length).toBeGreaterThanOrEqual(2);
      expect(shutdownPolls.slice(-2).every((l) => l.fields.claimed === 0)).toBe(
        true,
      );
      if (periodicTail.length === 1)
        expect(afterDraining.indexOf(periodicTail[0] as never)).toBeLessThan(
          afterDraining.indexOf(shutdownPolls[0] as never),
        );
      const drainSummary = afterDraining.filter(
        (l) => l.event === 'outbox.drain',
      );
      expect(drainSummary).toHaveLength(1);
      expect(drainSummary[0]?.fields.skipped).toBe(false);
      expect(afterDraining.indexOf(drainSummary[0] as never)).toBeGreaterThan(
        afterDraining.indexOf(shutdownPolls.at(-1) as never),
      );
      const released = (await harness.auditRows('LEADER_RELEASED')).filter(
        (a) => a.payload.leaderId === p1Leader,
      );
      expect(released.map((a) => a.payload.market).sort()).toEqual([
        'KR',
        'US',
      ]);
      expect(
        p1
          .events('lease.released')
          .filter((l) => l.fields.auditPersisted === true),
      ).toHaveLength(2);
      evidence.step5 = { exit, pendingAtExit };

      // ---- 6. P2 takes over --------------------------------------------------
      const takeoverStart = Date.now();
      await harness.waitForNormal(p2, 15_000);
      evidence.step6TakeoverMs = Date.now() - takeoverStart;
      epochs = await harness.leaderEpochs();
      const p2Leader = p2.leaderId;
      expect(epochs.KR).toMatchObject({
        epoch: '2',
        leader_id: p2Leader,
        released_at: null,
      });
      expect(epochs.US).toMatchObject({
        epoch: '2',
        leader_id: p2Leader,
        released_at: null,
      });
      const p2Acquired = (await harness.auditRows('LEADER_ACQUIRED')).filter(
        (a) => a.payload.leaderId === p2Leader,
      );
      expect(p2Acquired).toHaveLength(2);
      const p2Token = harness.rest
        .requests()
        .filter((r) => r.path === '/oauth2/token')
        .at(-1);
      expect(p2Token).toBeDefined();
      expect(p2Token?.at ?? 0).toBeGreaterThan(
        Math.max(...p2Acquired.map((a) => a.occurred_at.getTime())),
      );
      for (const market of ['KR', 'US']) {
        const rel = released.find((a) => a.payload.market === market);
        const acq = p2Acquired.find((a) => a.payload.market === market);
        expect(rel?.occurred_at.getTime()).toBeLessThan(
          acq?.occurred_at.getTime() ?? 0,
        );
      }
      expect(harness.wsConnectionSamples.some((s) => s.connections === 0)).toBe(
        true,
      );
      expect(harness.ws.connections).toBe(2);
      expect(harness.ws.peakConcurrentConnections).toBe(2);
      expect(harness.ws.evictions).toBe(0);
      const servingLog = p2.stateLog('SERVING');
      expect(servingLog).toBeDefined();
      await waitUntil(
        () => p2.events('outbox.poll').length > 0,
        3_000,
        'P2 first periodic outbox poll',
      );
      const firstPoll = p2.events('outbox.poll')[0];
      expect(firstPoll?.t ?? 0).toBeGreaterThanOrEqual(
        servingLog?.t ?? Number.POSITIVE_INFINITY,
      );
      expect(
        (await collector.connect(p2.origin, client, 'P2', '0')).status,
      ).toBe(101);
      await waitUntil(
        async () => (await harness.pendingOutbox()).length === 0,
        2_000,
        'pending outbox drained by P2',
      );
      await waitUntil(
        () =>
          collector
            .uniqueEvents()
            .some((e) => e.eventType === 'ORDER_CANCELLED'),
        5_000,
        'cancel event delivered exactly once',
      );
      const cancelEvents = collector
        .uniqueEvents()
        .filter((e) => e.eventType === 'ORDER_CANCELLED');
      expect(cancelEvents).toHaveLength(1);
      evidence.step6CancelPath = collector.frames.find(
        (f) => f.frame.eventType === 'ORDER_CANCELLED',
      )?.socket;

      // ---- 7. fills on P2 carry epoch 2 -------------------------------------
      emitBooks();
      await sleep(200);
      const filledOnP2 = await harness.placeOrder(
        p2,
        client,
        marketOrder('US', 'AAPL'),
      );
      expect(filledOnP2.status, JSON.stringify(filledOnP2.body)).toBeLessThan(
        300,
      );
      await waitUntil(
        async () =>
          Number(
            (
              await harness.observer.query(
                'select count(*)::int as n from fills where recovery_epoch = 2',
              )
            ).rows[0]?.n,
          ) >= 1,
        10_000,
        'fill with epoch 2',
      );

      // ---- 8. audit ordering -------------------------------------------------
      const runtimeAudits = (await harness.auditRows('RUNTIME_%'))
        .filter((a) => a.payload.leaderId === p1Leader)
        .map((a) => a.event_type);
      expect(runtimeAudits.indexOf('RUNTIME_DRAINING')).toBeGreaterThanOrEqual(
        0,
      );
      expect(runtimeAudits.at(-1)).toBe('RUNTIME_STOPPED');
      const allReleased = await harness.auditRows('LEADER_RELEASED');
      expect(
        allReleased.filter((a) => a.payload.leaderId === p1Leader),
      ).toHaveLength(2);
      const firstP1Not503 = harness.observations.find(
        (o) =>
          o.process === 'P1' &&
          o.endpoint === '/health/ready' &&
          o.status === 503,
      );
      const firstP2Recovering = harness.observations.find(
        (o) =>
          o.process === 'P2' &&
          o.endpoint === '/health/market-data' &&
          (o.body as { KR?: { state?: string } })?.KR?.state === 'RECOVERING' &&
          (o.body as { runtime?: string })?.runtime === 'RECOVERING',
      );
      if (firstP1Not503 && firstP2Recovering)
        expect(firstP1Not503.t).toBeLessThan(firstP2Recovering.t);

      // ---- 9. SIGKILL P2 → P3 recovers with epoch 3 ------------------------
      const killed = await harness.stop(p2, 'SIGKILL');
      expect(killed.signal).toBe('SIGKILL');
      const p3 = await bootToServing('P3');
      epochs = await harness.leaderEpochs();
      expect(epochs.KR?.epoch).toBe('3');
      expect(epochs.US?.epoch).toBe('3');
      expect(
        (await collector.connect(p3.origin, client, 'P3', '0')).status,
      ).toBe(101);
      await waitUntil(
        () =>
          collector.frames.some(
            (f) => f.socket === 'P3' && f.frame.type === 'ready',
          ),
        5_000,
        'P3 ready frame',
      );
      await sleep(500);
      expect(
        collector
          .uniqueEvents()
          .filter((e) => e.eventType === 'ORDER_CANCELLED'),
      ).toHaveLength(1);

      // ---- 10. partial lease loss with a concurrent waiter -------------------
      const p3Leader = p3.leaderId;
      const p4 = await harness.spawn('P4');
      await harness.waitForLive(p4, 10_000);
      await waitUntil(
        async () =>
          reasons(await harness.trading(p4)).includes('ACQUIRING_LEASES'),
        5_000,
        'P4 ACQUIRING_LEASES',
      );
      const restBeforeLoss = harness.rest.requests().length;
      const krPid = await harness.leaseBackendPid(p3Leader, 'KR');
      const lossAt = Date.now();
      await harness.observer.query('select pg_terminate_backend($1)', [krPid]);
      await waitUntil(
        () => p3.stateLog('RE_ELECTING') !== undefined,
        2_000,
        'P3 RE_ELECTING',
      );
      expect((p3.stateLog('RE_ELECTING')?.t ?? 0) - lossAt).toBeLessThan(1_500);
      await waitUntil(
        async () =>
          (await harness.auditRows('LEADER_RELEASED')).some(
            (a) => a.payload.leaderId === p3Leader && a.payload.market === 'US',
          ),
        5_000,
        'P3 released US',
      );
      expect(
        (await harness.auditRows('LEADER_RELEASED')).filter(
          (a) => a.payload.leaderId === p3Leader && a.payload.market === 'KR',
        ),
      ).toHaveLength(0);
      await harness.waitForNormal(p4, 15_000);
      epochs = await harness.leaderEpochs();
      expect(epochs.KR?.leader_id).toBe(p4.leaderId);
      expect(epochs.US?.leader_id).toBe(p4.leaderId);
      expect(Number(epochs.KR?.epoch)).toBeGreaterThan(3);
      expect(Number(epochs.US?.epoch)).toBeGreaterThan(3);
      const p4Acquired = (await harness.auditRows('LEADER_ACQUIRED')).filter(
        (a) => a.payload.leaderId === p4.leaderId,
      );
      const p4Token = harness.rest
        .requests()
        .filter((r) => r.path === '/oauth2/token' && r.at > lossAt)
        .at(-1);
      expect(p4Token?.at ?? 0).toBeGreaterThan(
        Math.max(...p4Acquired.map((a) => a.occurred_at.getTime())),
      );
      expect(harness.ws.peakConcurrentConnections).toBe(2);
      expect(harness.ws.evictions).toBe(0);
      // Both provider connections were closed before the successor opened
      // its own: the connection log (event-based, not the 100 ms sampler,
      // which can miss a window of a few milliseconds) shows a moment with
      // zero connections after the loss.
      expect(
        harness.ws.lifecycle
          .filter((e) => e.t > lossAt)
          .some((e) => e.event === 'close' && e.concurrent === 0),
      ).toBe(true);
      expect((await harness.ready(p3)).status).toBe(200);
      const p3Reasons = reasons(await harness.trading(p3));
      expect(p3Reasons).toContain('CANCEL_ONLY');
      // RE_ELECTING tears both markets down, then polls as ACQUIRING_LEASES (§6.1).
      expect(
        p3Reasons.includes('RE_ELECTING') ||
          p3Reasons.includes('ACQUIRING_LEASES'),
      ).toBe(true);
      expect(
        (await harness.placeOrder(p3, client, marketOrder('US', 'AAPL')))
          .status,
      ).toBe(409);
      expect(
        (await collector.connect(p3.origin, client, 'P3-reelecting')).status,
      ).toBe(503);
      await waitUntil(
        () =>
          p3
            .events('lease.waiting')
            .some((l) => l.fields.market === 'KR' && l.t > lossAt),
        5_000,
        'P3 waits for KR again',
      );
      // A dead backend frees KR instantly, so the successor may hold KR for a
      // few ms before the loser commits its US release. The invariant is that
      // no split bundle *persists* (§3.11): no run of split samples ≥ 500 ms.
      const isSplit = (s: { rows: unknown[] }) => {
        const live = (
          s.rows as { leader_id: string; released_at: Date | null }[]
        ).filter((r) => r.released_at === null);
        return live.length === 2 && live[0]?.leader_id !== live[1]?.leader_id;
      };
      let longestSplitMs = 0;
      let runStart: number | undefined;
      for (const sample of harness.leaderEpochSamples) {
        if (isSplit(sample)) {
          runStart ??= sample.t;
          longestSplitMs = Math.max(longestSplitMs, sample.t - runStart);
        } else runStart = undefined;
      }
      expect(longestSplitMs).toBeLessThan(500);
      evidence.step10LongestSplitMs = longestSplitMs;
      evidence.step10 = {
        restBeforeLoss,
        restAfter: harness.rest.requests().length,
      };

      // ---- 11. SIGTERM while polling exits fast with zero provider calls -----
      const restBeforeStop = harness.rest.requests().length;
      const wsHandshakesBefore = harness.ws.handshakeStatuses.length;
      const p3Exit = await harness.stop(p3);
      expect(p3Exit.code).toBe(0);
      expect(p3Exit.ms).toBeLessThan(3_000);
      expect(harness.rest.requests().length).toBe(restBeforeStop);
      expect(harness.ws.handshakeStatuses.length).toBe(wsHandshakesBefore);
      const p3Audits = (await harness.auditRows('RUNTIME_%'))
        .filter((a) => a.payload.leaderId === p3Leader)
        .map((a) => a.event_type);
      expect(p3Audits).toEqual(
        expect.arrayContaining(['RUNTIME_DRAINING', 'RUNTIME_STOPPED']),
      );
      const p3AcquiredAfterLoss = (
        await harness.auditRows('LEADER_ACQUIRED')
      ).filter(
        (a) =>
          a.payload.leaderId === p3Leader && a.occurred_at.getTime() > lossAt,
      );
      expect(p3AcquiredAfterLoss).toHaveLength(0);
      await collector.closeAll();
      await harness.stop(p4);
      expect(await harness.advisoryLockCount()).toBe(0);
      evidence.summary = {
        peakConcurrentConnections: harness.ws.peakConcurrentConnections,
        evictions: harness.ws.evictions,
      };
    },
    DRILL_TIMEOUT_MS,
  );
});
