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
import { accessSync, constants, mkdtempSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FAKE_ADMIN_KEY,
  fakeJwt,
  fakePostgresUri,
  fakeWebhook,
} from '../../scripts/lib/secret-fixtures.mjs';

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

/** Finds `name` on the real PATH, the way `command -v` would. */
function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

/**
 * A PATH holding exactly `names` — everything `notify.sh` needs except the one
 * dependency under test. `notify.sh` masks with perl, so perl missing must mean
 * no message rather than an unmasked one: delivery fails open, a secret does
 * not. This takes the dependency away without touching the host.
 */
function pathWithout(names) {
  const dir = mkdtempSync(join(tmpdir(), 'moi-notify-path-'));
  for (const name of names) {
    const target = onPath(name);
    assert.ok(target, `${name} is missing from the test host's PATH`);
    symlinkSync(target, join(dir, name));
  }
  return dir;
}

const WITHOUT_PERL = ['bash', 'jq', 'curl', 'sed', 'hostname', 'date'];

describe('notify.sh dependencies', () => {
  it('refuses to post at all when perl, the masker, is missing', async () => {
    bodies.length = 0;
    const bin = pathWithout(WITHOUT_PERL);
    const result = await new Promise((resolve) => {
      execFile(
        notify,
        [
          'fail',
          'unit failed',
          `Bearer ${fakeJwt('SUPERSECRETTOKENVALUE12345')}`,
        ],
        {
          encoding: 'utf8',
          env: { PATH: bin, DISCORD_WEBHOOK_URL: webhookUrl },
        },
        (error, _stdout, stderr) => resolve({ code: error?.code ?? 0, stderr }),
      );
    });

    assert.match(result.stderr, /perl missing/);
    assert.deepEqual(bodies, [], 'notify.sh posted without a masker');
  });

  it('exits non-zero for a missing masker under NOTIFY_STRICT', async () => {
    const bin = pathWithout(WITHOUT_PERL);
    const code = await new Promise((resolve) => {
      execFile(
        notify,
        ['fail', 'unit failed'],
        {
          encoding: 'utf8',
          env: {
            PATH: bin,
            DISCORD_WEBHOOK_URL: webhookUrl,
            NOTIFY_STRICT: '1',
          },
        },
        (error) => resolve(error?.code ?? 0),
      );
    });

    assert.equal(code, 1);
  });
});

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
        `Authorization: Bearer ${fakeJwt()}`,
      ].join(' | '),
    );

    for (const secret of [
      's%3AZm9vYmFyLXNlc3Npb24.9xKq',
      '7f3c1a9e5b2d40689c0e2f1b4a6d8e07',
      'abcdefghijklmnop',
      '3d0f1c22-0e1a-4a55-b2ad-9c5e1f0a7b31',
      fakeJwt(),
    ])
      assert.ok(!body.includes(secret), `notify.sh leaked ${secret}`);
  });

  it('keeps masking webhook URLs, URL credentials and KEY=VALUE assignments', async () => {
    const body = await post(
      'warn',
      'status degraded',
      `${fakeWebhook('1', 'leak')} ${fakePostgresUri()} ADMIN_API_KEY=${FAKE_ADMIN_KEY}`,
    );

    for (const secret of ['webhooks/1/leak', 'hunter2', FAKE_ADMIN_KEY])
      assert.ok(!body.includes(secret), `notify.sh leaked ${secret}`);
  });

  /**
   * A journal tail is many lines, and `sed` works one line at a time: every
   * rule here used to match only while the secret sat on the same line as its
   * marker. `alert-unit-failed.sh` forwards exactly that kind of text, and a
   * wrapped log line puts the value on the next one.
   */
  it('masks a secret that sits on the line after its marker', async () => {
    const body = await post(
      'fail',
      'unit failed: moi.service',
      [
        'Authorization: Bearer',
        fakeJwt('SUPERSECRETTOKENVALUE12345'),
        'Cookie: moi_session=',
        'Zm9vYmFyc2Vzc2lvbnZhbHVl',
        'X-CSRF-Token:',
        '7f3c1a9e5b2d40689c0e2f1b4a6d8e07',
        'ADMIN_API_KEY=',
        FAKE_ADMIN_KEY,
      ].join('\n'),
    );

    for (const secret of [
      fakeJwt('SUPERSECRETTOKENVALUE12345'),
      'Zm9vYmFyc2Vzc2lvbnZhbHVl',
      '7f3c1a9e5b2d40689c0e2f1b4a6d8e07',
      FAKE_ADMIN_KEY,
    ])
      assert.ok(!body.includes(secret), `notify.sh leaked ${secret}`);
  });

  it('keeps the line structure of a multi-line journal tail', async () => {
    const body = await post(
      'fail',
      'unit failed: moi.service',
      'first line\nsecond line\nthird line',
    );
    const { embeds } = JSON.parse(body);

    assert.equal(embeds[0].description, 'first line\nsecond line\nthird line');
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
