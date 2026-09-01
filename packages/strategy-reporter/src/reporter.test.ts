import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionSwapped } from './events.js';
import { DEFAULT_RATE_LIMIT } from './rate-limit.js';
import { createReporter, MAX_QUEUED, type Reporter } from './reporter.js';
import {
  type FakeDiscordServer,
  startFakeDiscord,
} from './testing/fake-discord-server.js';
import { fakeJwt } from './testing/secret-fixtures.js';

const CSRF_TOKEN = '7f3c1a9e5b2d40689c0e2f1b4a6d8e07';
const SESSION_COOKIE = 's%3AZm9vYmFyLXNlc3Npb24tdmFsdWU.9xKq';
const ADMIN_API_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('createReporter', () => {
  let discord: FakeDiscordServer;
  let now: number;
  let reporter: Reporter;

  const build = (overrides: Record<string, unknown> = {}) =>
    createReporter({
      webhookUrl: discord.webhookUrl,
      source: 'moi-bot',
      now: () => now,
      secrets: () => [
        discord.webhookUrl,
        CSRF_TOKEN,
        SESSION_COOKIE,
        ADMIN_API_KEY,
      ],
      ...overrides,
    });

  beforeEach(async () => {
    now = 1_700_000_000_000;
    discord = await startFakeDiscord();
    reporter = build();
  });
  afterEach(async () => {
    await reporter.close();
    await discord.close();
  });

  it('posts a session swap as a warn embed that keeps the old sessionId (§4.3)', async () => {
    reporter.report(
      sessionSwapped({
        previousSessionId: '01J8Z0Q9',
        sessionId: '01J8Z1AA',
        reason: 'the stored cookie was rejected with 401',
      }),
    );
    await reporter.flush();

    const [embed] = JSON.parse(discord.bodies()[0] ?? '{}').embeds;
    expect(embed.color).toBe(16_098_596);
    expect(embed.title).toBe('session replaced');
    expect(embed.fields).toContainEqual({
      name: 'previous sessionId',
      value: '01J8Z0Q9',
      inline: true,
    });
    expect(embed.footer.text).toContain('session-swapped');
  });

  it('a held secret cannot cross the socket through any field', async () => {
    reporter.report({
      level: 'fail',
      kind: 'leaky',
      title: `posting to ${discord.webhookUrl}`,
      description: `Cookie: moi_session=${SESSION_COOKIE}; X-CSRF-Token: ${CSRF_TOKEN}`,
      fields: [
        { name: `ADMIN_API_KEY=${ADMIN_API_KEY}`, value: ADMIN_API_KEY },
        { name: 'authorization', value: `Bearer ${fakeJwt()}` },
      ],
    });
    await reporter.flush();

    const wire = discord.bodies().join('\n');
    expect(wire).toHaveLength(wire.length);
    for (const secret of [
      CSRF_TOKEN,
      SESSION_COOKIE,
      ADMIN_API_KEY,
      'fake-webhook-token',
      fakeJwt(),
    ])
      expect(wire).not.toContain(secret);
  });

  it('drops the payload rather than posting when a held secret survives masking', async () => {
    await reporter.close();
    reporter = build({ mask: (text: string) => text });

    reporter.report({ level: 'fail', kind: 'leaky', title: CSRF_TOKEN });
    await reporter.flush();

    expect(discord.requests()).toHaveLength(0);
    expect(reporter.stats().blocked).toBe(1);
  });

  it('never throws and never rejects a decision when Discord is down', async () => {
    discord.answerAlways({ status: 503 });

    expect(() =>
      reporter.report({ level: 'info', kind: 'heartbeat', title: 'alive' }),
    ).not.toThrow();
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(reporter.stats().failed).toBe(1);
  });

  /**
   * The diagnostic sink is the runner's logger, so AGENTS.md hard rule 2
   * covers it too. A diagnostic names the event and a status — and the event
   * name is caller-supplied text, which is exactly where a secret arrives.
   */
  it('masks the diagnostics it emits, both the delivery one and the tripwire one', async () => {
    await reporter.close();
    const diagnostics: string[] = [];

    reporter = build({
      onDiagnostic: (line: string) => diagnostics.push(line),
    });
    discord.answerAlways({ status: 503 });
    reporter.report({
      level: 'warn',
      kind: `resumed moi_session=${SESSION_COOKIE}`,
      title: 'resumed',
    });
    await reporter.flush();

    await reporter.close();
    reporter = build({
      mask: (text: string) => text,
      onDiagnostic: (line: string) => diagnostics.push(line),
    });
    reporter.report({
      level: 'fail',
      kind: `key ${ADMIN_API_KEY}`,
      title: 'x',
    });
    await reporter.flush();

    expect(diagnostics).toHaveLength(2);
    const text = diagnostics.join('\n');
    expect(text).not.toContain(SESSION_COOKIE);
    expect(text).not.toContain(ADMIN_API_KEY);
    expect(text).toContain('not delivered');
    expect(text).toContain('survived rendering');
  });

  it('is a silent no-op without a webhook, the way notify.sh is', async () => {
    await reporter.close();
    reporter = build({ webhookUrl: '' });

    reporter.report({ level: 'fail', kind: 'kill-switch', title: 'stopped' });
    await reporter.flush();

    expect(discord.requests()).toHaveLength(0);
    expect(reporter.stats().dropped).toBe(1);
  });

  it('collapses a per-tick flood into one message carrying the count', async () => {
    for (let i = 0; i < 100; i += 1) {
      reporter.report({ level: 'info', kind: 'decision', title: `tick ${i}` });
      now += 200;
    }
    await reporter.flush();

    expect(discord.requests()).toHaveLength(1);

    now += DEFAULT_RATE_LIMIT.aggregationWindowMs;
    reporter.report({ level: 'info', kind: 'decision', title: 'tick 100' });
    await reporter.flush();

    const [embed] = JSON.parse(discord.bodies()[1] ?? '{}').embeds;
    expect(embed.footer.text).toContain('+99 suppressed');
  });

  it('keeps a deferred alert queued until a token exists instead of losing it', async () => {
    for (let i = 0; i < DEFAULT_RATE_LIMIT.capacity; i += 1)
      reporter.report({ level: 'fail', kind: `f${i}`, title: 'boom' });
    reporter.report({
      level: 'fail',
      kind: 'residual',
      title: 'orders remain',
    });
    await reporter.flush();

    expect(discord.requests()).toHaveLength(DEFAULT_RATE_LIMIT.capacity);
    expect(reporter.stats().queued).toBe(1);

    now += DEFAULT_RATE_LIMIT.refillIntervalMs;
    await reporter.flush();

    expect(discord.requests()).toHaveLength(DEFAULT_RATE_LIMIT.capacity + 1);
    expect(reporter.stats().queued).toBe(0);
  });

  /**
   * The queue overflow path, which the deferral test above never reaches. An
   * incident produces alerts on many keys at once — a strategy failing on
   * several instruments — far faster than one token per 12 s, so the queue
   * fills with nothing but alerts. What must never happen is an alert
   * disappearing into the general `dropped` count with no distinct trace.
   */
  it('accounts for every alert when the queue fills with nothing but alerts', async () => {
    await reporter.close();
    const diagnostics: string[] = [];
    reporter = build({
      onDiagnostic: (line: string) => diagnostics.push(line),
    });

    const total = MAX_QUEUED + 55;
    for (let i = 0; i < total; i += 1)
      reporter.report({ level: 'fail', kind: `f${i}`, title: 'boom' });
    await reporter.flush();

    const stats = reporter.stats();
    expect(stats.alertsLost).toBeGreaterThan(0);
    // Routine throttling and alert loss are different facts about the run.
    expect(stats.dropped).toBe(0);
    // Nothing vanishes unaccounted for.
    expect(stats.posted + stats.queued + stats.alertsLost).toBe(total);
    expect(
      diagnostics.filter((line) => line.includes('alert queue is full')),
    ).toHaveLength(stats.alertsLost);
  });

  it('says on the next embed how many alerts were lost', async () => {
    for (let i = 0; i < MAX_QUEUED + 20; i += 1)
      reporter.report({ level: 'fail', kind: `f${i}`, title: 'boom' });
    await reporter.flush();
    const lost = reporter.stats().alertsLost;

    now += DEFAULT_RATE_LIMIT.refillIntervalMs;
    await reporter.flush();

    const footers = discord
      .bodies()
      .map((body) => JSON.parse(body).embeds[0].footer.text);
    expect(
      footers.some((text: string) => text.includes(`${lost} alerts lost`)),
    ).toBe(true);
  });

  it('loses nothing when the same alert repeats: the queued one carries it', async () => {
    for (let i = 0; i < MAX_QUEUED * 2; i += 1)
      reporter.report({
        level: 'fail',
        kind: 'residual',
        title: 'orders remain',
      });
    await reporter.flush();

    expect(reporter.stats().alertsLost).toBe(0);
  });

  it('never evicts a queued alert to make room for routine traffic', async () => {
    // Past the bound, so the queue is certainly full when the routine burst
    // arrives and every one of them meets the overflow path.
    for (let i = 0; i < MAX_QUEUED + 10; i += 1)
      reporter.report({ level: 'fail', kind: `f${i}`, title: 'boom' });
    const before = reporter.stats().alertsLost;
    for (let i = 0; i < 20; i += 1)
      reporter.report({ level: 'info', kind: `i${i}`, title: 'routine' });

    expect(reporter.stats().alertsLost).toBe(before);
    expect(reporter.stats().dropped).toBe(20);
    await reporter.flush();
  });

  it('lets routine traffic be dropped before an alert is starved', async () => {
    for (let i = 0; i < 10; i += 1)
      reporter.report({ level: 'info', kind: `i${i}`, title: 'routine' });
    reporter.report({ level: 'fail', kind: 'kill-switch', title: 'stopped' });
    await reporter.flush();

    const titles = discord
      .bodies()
      .map((body) => JSON.parse(body).embeds[0].title);
    expect(titles).toContain('stopped');
    expect(reporter.stats().dropped).toBeGreaterThan(0);
  });
});
