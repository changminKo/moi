import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDiscordWebhookTransport } from './discord-transport.js';
import {
  type FakeDiscordServer,
  startFakeDiscord,
} from './testing/fake-discord-server.js';

const PAYLOAD = { embeds: [{ title: 'hello', color: 1 }] };

describe('createDiscordWebhookTransport', () => {
  let discord: FakeDiscordServer;

  beforeEach(async () => {
    discord = await startFakeDiscord();
  });
  afterEach(async () => {
    await discord.close();
  });

  const transport = (waitMs = 0) =>
    createDiscordWebhookTransport({
      webhookUrl: discord.webhookUrl,
      timeoutMs: 2_000,
      wait: async () => {
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      },
    });

  it('posts the payload as JSON and reports delivery', async () => {
    const result = await transport().send(PAYLOAD);

    expect(result).toMatchObject({ delivered: true, status: 204 });
    expect(discord.requests()).toHaveLength(1);
    expect(discord.requests()[0]?.method).toBe('POST');
    expect(discord.requests()[0]?.contentType).toBe('application/json');
    expect(JSON.parse(discord.bodies()[0] ?? '')).toStrictEqual(PAYLOAD);
  });

  it('fails open on a server error: it reports, it does not throw', async () => {
    discord.answerAlways({ status: 500, body: 'nope' });

    await expect(transport().send(PAYLOAD)).resolves.toMatchObject({
      delivered: false,
      status: 500,
    });
  });

  it('fails open when the webhook host is unreachable', async () => {
    await discord.close();

    const result = await transport().send(PAYLOAD);

    expect(result.delivered).toBe(false);
    expect(result.reason).toBeDefined();
    discord = await startFakeDiscord();
  });

  it('retries a 429 once, honouring retry_after', async () => {
    discord.answerOnce({ status: 429, retryAfter: 0.01 });

    const result = await transport().send(PAYLOAD);

    expect(result).toMatchObject({ delivered: true, status: 204 });
    expect(discord.requests()).toHaveLength(2);
  });

  it('gives up after one retry rather than hammering the webhook', async () => {
    discord.answerAlways({ status: 429, retryAfter: 0.01 });

    const result = await transport().send(PAYLOAD);

    expect(result.delivered).toBe(false);
    expect(discord.requests()).toHaveLength(2);
  });

  it('never puts the webhook URL in the failure reason', async () => {
    discord.answerAlways({ status: 401, body: 'unauthorized' });

    const result = await transport().send(PAYLOAD);

    expect(result.reason ?? '').not.toContain(discord.webhookUrl);
    expect(JSON.stringify(result)).not.toContain('fake-webhook-token');
  });
});
