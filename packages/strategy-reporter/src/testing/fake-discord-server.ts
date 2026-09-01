/**
 * A loopback stand-in for a Discord channel webhook.
 *
 * AGENTS.md hard rule 1 forbids code, tests or CI from reaching the real
 * service, and `packages/market-data/src/testing/fake-toss` is the shape this
 * follows: a `node:http` server on 127.0.0.1:0 that records what it was sent
 * and can be told to answer with any status.
 *
 * It records the raw request body verbatim, which is the point: a test proves
 * masking by asserting on what actually crossed the socket rather than on
 * what the reporter believed it wrote.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeDiscordRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly body: string;
  readonly at: number;
}

export interface FakeDiscordResponse {
  readonly status: number;
  readonly body?: string;
  /** Seconds, as Discord reports them on a 429. */
  readonly retryAfter?: number;
}

export interface FakeDiscordServer {
  /** The URL a reporter posts to. Shaped like a real webhook path. */
  readonly webhookUrl: string;
  requests(): readonly FakeDiscordRequest[];
  bodies(): readonly string[];
  /** Answers the next request with `response`, then returns to 204. */
  answerOnce(response: FakeDiscordResponse): void;
  /** Answers every request with `response` until changed. */
  answerAlways(response: FakeDiscordResponse): void;
  close(): Promise<void>;
}

const WEBHOOK_PATH = '/api/webhooks/900000000000000000/fake-webhook-token';

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeDiscord(): Promise<FakeDiscordServer> {
  const received: FakeDiscordRequest[] = [];
  let always: FakeDiscordResponse = { status: 204 };
  const once: FakeDiscordResponse[] = [];

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readBody(request);
    received.push({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      contentType: request.headers['content-type'],
      body,
      at: Date.now(),
    });
    const answer = once.shift() ?? always;
    const headers: Record<string, string> = {};
    let payload = answer.body ?? '';
    if (answer.retryAfter !== undefined) {
      headers['content-type'] = 'application/json';
      headers['retry-after'] = String(answer.retryAfter);
      payload = JSON.stringify({
        message: 'You are being rate limited.',
        retry_after: answer.retryAfter,
        global: false,
      });
    }
    response.writeHead(answer.status, headers);
    response.end(payload);
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    webhookUrl: `http://127.0.0.1:${port}${WEBHOOK_PATH}`,
    requests: () => [...received],
    bodies: () => received.map((entry) => entry.body),
    answerOnce: (response) => once.push(response),
    answerAlways: (response) => {
      always = response;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
