/**
 * `notify.sh` masking, end to end.
 *
 * Strategy-runner design §7.4 adds the session cookie, the CSRF token,
 * `Set-Cookie` and the idempotency key to the masking rules on both sides —
 * the runner (`@moi/strategy-reporter`) and this host script. A journal tail
 * forwarded by `alert-unit-failed.sh` is exactly where such a value shows up.
 *
 * The webhook points at a loopback server, never at Discord (AGENTS.md hard
 * rule 1), and the assertions read the bytes that actually crossed the socket.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const notify = join(
  resolve(dirname(fileURLToPath(import.meta.url))),
  'notify.sh',
);

let server;
let webhookUrl;
const bodies = [];

before(async () => {
  server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(204).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  webhookUrl = `http://127.0.0.1:${server.address().port}/api/webhooks/1/tok`;
});
after(() => server.close());

/**
 * Runs notify.sh against the loopback webhook and returns what arrived.
 * `execFile` rather than `spawnSync`: a synchronous child would block this
 * process's event loop, so the server could never answer and every post would
 * silently time out into notify.sh's fail-open path. NOTIFY_STRICT=1 turns
 * that fail-open into a non-zero exit, so a lost post fails the test.
 */
function post(level, title, description) {
  bodies.length = 0;
  return new Promise((resolve, reject) => {
    execFile(
      notify,
      [level, title, description],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DISCORD_WEBHOOK_URL: webhookUrl,
          NOTIFY_STRICT: '1',
        },
      },
      (error, _stdout, stderr) =>
        error
          ? reject(new Error(`notify.sh failed: ${stderr}`))
          : resolve(bodies.join('\n')),
    );
  });
}

describe('notify.sh masking', () => {
  it('posts an embed for a well-formed call', async () => {
    const body = await post('info', 'deploy started: main', 'host moi-1');
    const { embeds } = JSON.parse(body);
    assert.equal(embeds[0].title, 'deploy started: main');
    assert.equal(embeds[0].color, 5793266);
  });

  it('masks the session cookie, CSRF token, Set-Cookie and idempotency key', async () => {
    const body = await post(
      'fail',
      'unit failed: moi.service',
      [
        'Cookie: moi_session=s%3AZm9vYmFyLXNlc3Npb24.9xKq; Path=/',
        'X-CSRF-Token: 7f3c1a9e5b2d40689c0e2f1b4a6d8e07',
        'Set-Cookie: moi_session=abcdefghijklmnop; HttpOnly',
        'Idempotency-Key: 3d0f1c22-0e1a-4a55-b2ad-9c5e1f0a7b31',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload',
      ].join(' | '),
    );

    for (const secret of [
      's%3AZm9vYmFyLXNlc3Npb24.9xKq',
      '7f3c1a9e5b2d40689c0e2f1b4a6d8e07',
      'abcdefghijklmnop',
      '3d0f1c22-0e1a-4a55-b2ad-9c5e1f0a7b31',
      'eyJhbGciOiJIUzI1NiJ9.payload',
    ])
      assert.ok(!body.includes(secret), `notify.sh leaked ${secret}`);
  });

  it('keeps masking webhook URLs, URL credentials and KEY=VALUE assignments', async () => {
    const body = await post(
      'warn',
      'status degraded',
      'https://discord.com/api/webhooks/1/leak postgres://moi:hunter2@db/moi ADMIN_API_KEY=0123456789abcdef',
    );

    for (const secret of ['webhooks/1/leak', 'hunter2', '0123456789abcdef'])
      assert.ok(!body.includes(secret), `notify.sh leaked ${secret}`);
  });

  it('does not mask the identifiers an operator needs to read', async () => {
    const body = await post(
      'ok',
      'deploy finished: main',
      'ref main, KR/US NORMAL',
    );
    assert.ok(body.includes('KR/US NORMAL'));
  });
});
