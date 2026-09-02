import { describe, expect, it } from 'vitest';
import { runUntilStopped, wireReporter } from './reporter-wiring.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/abcDEF_ghi-jkl';

describe('wireReporter', () => {
  it('writes lines only when no trade webhook is configured', async () => {
    const lines: string[] = [];
    const wiring = wireReporter({
      env: {},
      write: (line) => lines.push(line),
      secrets: () => [],
    });

    wiring.reporter.report('info', 'hello', { a: 1 });
    await wiring.close();

    expect(wiring.discord).toBe(false);
    expect(lines).toStrictEqual(['[info] hello a=1']);
  });

  it('fans out to Discord and stdout when the trade webhook is set, masking held secrets', async () => {
    const lines: string[] = [];
    const sent: unknown[] = [];
    const wiring = wireReporter({
      env: { DISCORD_WEBHOOK_TRADE_URL: WEBHOOK },
      write: (line) => lines.push(line),
      secrets: () => ['cookie-value-0123456789'],
      source: 'test-host',
      transport: {
        send: async (payload) => {
          sent.push(payload);

          return { delivered: true, status: 204 };
        },
      },
    });

    wiring.reporter.report('error', 'the kill switch is engaged', {
      reason: 'cookie-value-0123456789 leaked',
    });
    await wiring.close();

    expect(wiring.discord).toBe(true);
    expect(lines).toHaveLength(1);
    // Held secrets are masked by value on *both* outputs: `docker logs` is a
    // log too (AGENTS.md rule 2).
    expect(lines[0]).not.toContain('cookie-value-0123456789');
    expect(lines[0]).toContain('***');
    expect(sent).toHaveLength(1);

    const wire = JSON.stringify(sent[0]);

    expect(wire).not.toContain('cookie-value-0123456789');
    expect((sent[0] as { embeds: { color: number }[] }).embeds[0]?.color).toBe(
      15_026_253,
    );
  });

  it('masks held secrets on stdout even with no Discord channel', () => {
    const lines: string[] = [];
    const wiring = wireReporter({
      env: {},
      write: (line) => lines.push(line),
      secrets: () => ['csrf-token-value-0123456789'],
    });

    wiring.reporter.report('info', 'token csrf-token-value-0123456789 seen');

    expect(lines[0]).toBe('[info] token *** seen');
  });

  it('keeps reporting when the secrets provider throws', async () => {
    const lines: string[] = [];
    const sent: unknown[] = [];
    const wiring = wireReporter({
      env: { DISCORD_WEBHOOK_TRADE_URL: WEBHOOK },
      write: (line) => lines.push(line),
      secrets: () => {
        throw new Error('the session cell is torn');
      },
      transport: {
        send: async (payload) => {
          sent.push(payload);

          return { delivered: true, status: 204 };
        },
      },
    });

    wiring.reporter.report('warn', 'a strategy threw on a tick');
    await wiring.close();

    expect(lines).toStrictEqual(['[warn] a strategy threw on a tick']);
    expect(sent).toHaveLength(1);
  });

  it('refuses a malformed trade webhook instead of starting silent', () => {
    expect(() =>
      wireReporter({
        env: { DISCORD_WEBHOOK_TRADE_URL: 'http://not-discord.example' },
        secrets: () => [],
      }),
    ).toThrow(
      /DISCORD_WEBHOOK_TRADE_URL must be an https Discord webhook URL/u,
    );
  });

  it('refuses the operational webhook reused as the trade webhook', () => {
    expect(() =>
      wireReporter({
        env: {
          DISCORD_WEBHOOK_TRADE_URL: WEBHOOK,
          DISCORD_WEBHOOK_URL: WEBHOOK,
        },
        secrets: () => [],
      }),
    ).toThrow(/must be a different channel/u);
  });

  /** Shutdown must not drop what Discord has queued: `close` flushes first. */
  it('flushes queued Discord posts on close', async () => {
    const sent: unknown[] = [];
    const wiring = wireReporter({
      env: { DISCORD_WEBHOOK_TRADE_URL: WEBHOOK },
      write: () => {},
      secrets: () => [],
      transport: {
        send: async (payload) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          sent.push(payload);

          return { delivered: true, status: 204 };
        },
      },
    });

    wiring.reporter.report('warn', 'a strategy threw on a tick');
    await wiring.close();

    expect(sent).toHaveLength(1);
  });
});

describe('runUntilStopped', () => {
  const fakeSupervisor = (run: () => Promise<void>, close?: () => void) => ({
    start: async () => {},
    run,
    close: close ?? (() => {}),
  });

  it('reports a crash through the wired reporter before closing the channel', async () => {
    const sent: unknown[] = [];
    const wiring = wireReporter({
      env: { DISCORD_WEBHOOK_TRADE_URL: WEBHOOK },
      write: () => {},
      secrets: () => [],
      transport: {
        send: async (payload) => {
          sent.push(payload);

          return { delivered: true, status: 204 };
        },
      },
    });

    await expect(
      runUntilStopped(
        fakeSupervisor(async () => {
          throw new Error('the loop died');
        }),
        wiring,
      ),
    ).rejects.toThrow('the loop died');

    const titles = sent.map(
      (payload) =>
        (payload as { embeds: { title: string }[] }).embeds[0]?.title,
    );

    expect(titles).toContain('the strategy runner stopped on an error');
  });

  it('still flushes the channel when closing the supervisor throws', async () => {
    const sent: unknown[] = [];
    const wiring = wireReporter({
      env: { DISCORD_WEBHOOK_TRADE_URL: WEBHOOK },
      write: () => {},
      secrets: () => [],
      transport: {
        send: async (payload) => {
          sent.push(payload);

          return { delivered: true, status: 204 };
        },
      },
    });

    wiring.reporter.report('info', 'stopping');

    await expect(
      runUntilStopped(
        fakeSupervisor(
          async () => {},
          () => {
            throw new Error('close failed');
          },
        ),
        wiring,
      ),
    ).rejects.toThrow('close failed');

    expect(sent.length).toBeGreaterThanOrEqual(1);
  });
});
