import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDiscordReporter,
  type RunnerReporter,
} from './discord-reporter.js';
import { DEFAULT_RATE_LIMIT } from './rate-limit.js';
import {
  type FakeDiscordServer,
  startFakeDiscord,
} from './testing/fake-discord-server.js';

const CSRF_TOKEN = '7f3c1a9e5b2d40689c0e2f1b4a6d8e07';

/**
 * The four shapes `apps/strategy-runner/src/transport/redact.ts` masks. Stated
 * here as inputs rather than imported — the runner may not be a dependency of
 * this package — so that a rule the runner has and this masker lacks fails
 * here rather than leaking to Discord.
 */
const RUNNER_REDACTED = [
  ['Set-Cookie: moi_session=abcdefghijklmnop; HttpOnly', 'abcdefghijklmnop'],
  ['Cookie: moi_session=s%3AZm9vYmFy.9xKq; Path=/', 's%3AZm9vYmFy.9xKq'],
  [`X-CSRF-Token: ${CSRF_TOKEN}`, CSRF_TOKEN],
  [
    'Idempotency-Key: 3d0f1c22-0e1a-4a55-b2ad-9c5e1f0a7b31',
    '3d0f1c22-0e1a-4a55-b2ad-9c5e1f0a7b31',
  ],
] as const;

describe('createDiscordReporter', () => {
  let discord: FakeDiscordServer;
  let now: number;
  let reporter: RunnerReporter & {
    flush(): Promise<void>;
    close(): Promise<void>;
  };

  beforeEach(async () => {
    now = 1_700_000_000_000;
    discord = await startFakeDiscord();
    reporter = createDiscordReporter({
      webhookUrl: discord.webhookUrl,
      source: 'moi-bot',
      now: () => now,
      secrets: () => [discord.webhookUrl],
    });
  });
  afterEach(async () => {
    await reporter.close();
    await discord.close();
  });

  const embeds = () =>
    discord.bodies().map((body) => JSON.parse(body).embeds[0]);

  it('is callable as the runner’s Reporter: report(level, message, fields)', async () => {
    reporter.report('warn', 'session replaced', {
      previousSessionId: '01J8Z0Q9',
      sessionId: '01J8Z1AA',
      attempt: 2,
      recovered: false,
    });
    await reporter.flush();

    const [embed] = embeds();
    expect(embed.title).toBe('session replaced');
    expect(embed.color).toBe(16_098_596);
    expect(embed.fields).toStrictEqual([
      { name: 'previousSessionId', value: '01J8Z0Q9', inline: true },
      { name: 'sessionId', value: '01J8Z1AA', inline: true },
      { name: 'attempt', value: '2', inline: true },
      { name: 'recovered', value: 'false', inline: true },
    ]);
  });

  it('maps the runner’s `error` onto the red the deploy notifier uses', async () => {
    reporter.report('error', 'the strategy runner refused to run');
    await reporter.flush();

    expect(embeds()[0].color).toBe(15_026_253);
  });

  it('masks every shape the runner’s own redactor masks', async () => {
    for (const [line] of RUNNER_REDACTED)
      reporter.report('error', line, { detail: line });
    await reporter.flush();

    const wire = discord.bodies().join('\n');
    for (const [, secret] of RUNNER_REDACTED)
      expect(wire, secret).not.toContain(secret);
  });

  // Masking twice is safe: a line the runner already put through `redact`
  // keeps its shape and reveals nothing new. The mask token differs — the
  // runner writes `[redacted]`, this masker writes `***` — and re-masking an
  // already-masked value is the harmless direction to be wrong in.
  it('is idempotent over a line the runner already masked', async () => {
    reporter.report('warn', 'submitted moi_session=[redacted] for 01J8Z0Q9');
    await reporter.flush();

    const { title } = embeds()[0];
    expect(title).toMatch(/^submitted moi_session=\S+ for 01J8Z0Q9$/);
    expect(title).not.toContain('moi_session=s');
  });

  it('dedupes on level and message, so changing fields cannot defeat the budget', async () => {
    for (let i = 0; i < 50; i += 1) {
      reporter.report('info', 'decision', { tick: i });
      now += 200;
    }
    await reporter.flush();

    expect(discord.requests()).toHaveLength(1);

    now += DEFAULT_RATE_LIMIT.aggregationWindowMs;
    reporter.report('info', 'decision', { tick: 50 });
    await reporter.flush();

    expect(embeds()[1].footer.text).toContain('+49 suppressed');
  });

  it('separates messages that differ, and levels that differ', async () => {
    reporter.report('info', 'decision');
    reporter.report('info', 'placed');
    reporter.report('warn', 'decision');
    await reporter.flush();

    expect(discord.requests()).toHaveLength(3);
  });

  it('never throws, whatever the runner hands it', async () => {
    discord.answerAlways({ status: 500 });

    expect(() => reporter.report('error', 'boom')).not.toThrow();
    await expect(reporter.flush()).resolves.toBeUndefined();
  });
});
