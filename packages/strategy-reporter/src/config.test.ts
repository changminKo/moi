import { describe, expect, it } from 'vitest';
import { readReporterConfig, TRADE_WEBHOOK_VARIABLE } from './config.js';

const TRADE = 'https://discord.com/api/webhooks/900000000000000000/trade-tok';
const OPS = 'https://discord.com/api/webhooks/800000000000000000/ops-token1';

describe('readReporterConfig', () => {
  it('reads the runner’s own webhook variable', () => {
    expect(TRADE_WEBHOOK_VARIABLE).toBe('DISCORD_WEBHOOK_TRADE_URL');
    expect(
      readReporterConfig({ DISCORD_WEBHOOK_TRADE_URL: TRADE }),
    ).toStrictEqual({ ok: true, webhookUrl: TRADE });
  });

  it('never falls back to the deploy channel’s webhook', () => {
    expect(readReporterConfig({ DISCORD_WEBHOOK_URL: OPS })).toStrictEqual({
      ok: true,
      webhookUrl: '',
    });
  });

  it('refuses the deploy webhook handed in under the trade name (§7.4)', () => {
    const result = readReporterConfig({
      DISCORD_WEBHOOK_TRADE_URL: OPS,
      DISCORD_WEBHOOK_URL: OPS,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toMatch(
      /must be a different channel/,
    );
  });

  it('refuses anything that is not a Discord webhook URL', () => {
    for (const value of [
      'http://discord.com/api/webhooks/1/tok',
      'https://example.com/api/webhooks/1/tok',
      'https://discord.com/api/channels/1',
      'not-a-url',
    ]) {
      const result = readReporterConfig({ DISCORD_WEBHOOK_TRADE_URL: value });
      expect(result.ok, value).toBe(false);
    }
  });

  it('is absent-tolerant: no variable means a silent no-op reporter', () => {
    expect(readReporterConfig({})).toStrictEqual({ ok: true, webhookUrl: '' });
    expect(
      readReporterConfig({ DISCORD_WEBHOOK_TRADE_URL: '  ' }),
    ).toStrictEqual({ ok: true, webhookUrl: '' });
  });

  it('never puts the rejected value in the problem it reports', () => {
    const result = readReporterConfig({
      DISCORD_WEBHOOK_TRADE_URL: 'https://example.com/secret-path-abcdef',
    });

    expect(result.ok === false && result.problem).not.toContain('secret-path');
  });
});
