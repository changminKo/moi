// Behavioural tests for infra/oracle/status-check.sh and notify.sh.
// Every collector is stubbed through environment variables and a fake `curl`
// placed first on PATH records what would have been posted to Discord.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const statusCheck = resolve(here, 'status-check.sh');
const notify = resolve(here, 'notify.sh');
const WEBHOOK = 'https://discord.example/webhook';

const API = {
  ready: 200,
  marketData:
    '{"KR":{"state":"NORMAL","reasons":[]},"US":{"state":"NORMAL","reasons":[]},"runtime":"SERVING"}',
  trading: '{"placement":true,"cancellation":true,"fx":true,"reasons":[]}',
  free: 'Mem: 954 400 100 10 454 600\nSwap: 4095 100 3995',
  df: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 20000000 30000000 40% /',
};

// A curl stand-in: the status check uses it for the API probes, notify.sh for
// the webhook POST. It routes on the URL and appends every POST body to a log.
function makeSandbox(api) {
  const dir = mkdtempSync(join(tmpdir(), 'moi-status-'));
  const bin = join(dir, 'bin');
  const posts = join(dir, 'posts.log');
  const fakeCurl = `#!/usr/bin/env bash
url=""; data=""; write_out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--data|--data-binary) data="$2"; shift 2;;
    -w|--write-out) write_out="$2"; shift 2;;
    -o|--output|-H|--header|--max-time|-X) shift 2;;
    -*) shift;;
    *) url="$1"; shift;;
  esac
done
if [ -n "$data" ]; then printf '%s\\n' "$data" >> "${posts}"; exit 0; fi
case "$url" in
  */health/ready) [ -n "$write_out" ] && printf '%s' "${api.ready}"; [ "${api.ready}" = 200 ] || exit 22;;
  */health/market-data) printf '%s' '${api.marketData}';;
  */api/v1/health/trading) printf '%s' '${api.trading}';;
  *) echo "unexpected url $url" >&2; exit 7;;
esac
`;
  writeFileSync(join(dir, 'curl'), fakeCurl);
  chmodSync(join(dir, 'curl'), 0o755);
  writeFileSync(
    join(dir, 'free'),
    `#!/usr/bin/env bash\nprintf '%s\\n' '${api.free.replace(/\n/g, "' '")}'\n`,
  );
  chmodSync(join(dir, 'free'), 0o755);
  writeFileSync(
    join(dir, 'df'),
    `#!/usr/bin/env bash\nprintf '%s\\n' '${api.df.replace(/\n/g, "' '")}'\n`,
  );
  chmodSync(join(dir, 'df'), 0o755);
  spawnSync('mkdir', ['-p', bin]);
  for (const f of ['curl', 'free', 'df'])
    spawnSync('mv', [join(dir, f), join(bin, f)]);
  return { dir, bin, posts, state: join(dir, 'status.last') };
}

function runStatus(sb, extraEnv = {}) {
  const result = spawnSync('bash', [statusCheck], {
    env: {
      PATH: `${sb.bin}:${process.env.PATH}`,
      HOME: sb.dir,
      MOI_STATUS_API_BASE: 'https://api.moi.example',
      MOI_STATUS_STATE_FILE: sb.state,
      DISCORD_WEBHOOK_URL: WEBHOOK,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
  return result;
}

function posted(sb) {
  return existsSync(sb.posts)
    ? readFileSync(sb.posts, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

describe('status-check.sh', () => {
  it('reports ok, posts the first observation, then stays quiet while unchanged', () => {
    const sb = makeSandbox(API);
    try {
      const first = runStatus(sb);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /^ok /);
      assert.equal(posted(sb).length, 1, 'first observation is announced once');
      const second = runStatus(sb);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(
        posted(sb).length,
        1,
        'unchanged status must not post again',
      );
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('posts fail once when a market leaves NORMAL and recovery when it returns', () => {
    const sb = makeSandbox(API);
    try {
      runStatus(sb); // baseline ok
      const degraded = makeSandbox({
        ...API,
        marketData: API.marketData.replace(
          '"US":{"state":"NORMAL"',
          '"US":{"state":"DEGRADED"',
        ),
      });
      const r1 = runStatus({ ...degraded, state: sb.state });
      assert.equal(r1.status, 0, r1.stderr);
      assert.match(r1.stdout, /^fail /);
      assert.match(r1.stdout, /US=DEGRADED/);
      const r2 = runStatus({ ...degraded, state: sb.state });
      assert.equal(r2.status, 0);
      const degradedPosts = posted(degraded);
      assert.equal(degradedPosts.length, 1, 'same failure is not re-posted');
      const body = JSON.parse(degradedPosts[0]);
      assert.equal(body.embeds[0].color, 0xe5484d);
      assert.match(body.embeds[0].title, /status FAIL/i);
      rmSync(degraded.dir, { recursive: true, force: true });

      const recovered = runStatus(sb);
      assert.match(recovered.stdout, /^ok /);
      const all = posted(sb);
      assert.equal(all.length, 2, 'recovery is announced');
      assert.match(JSON.parse(all[1]).embeds[0].title, /recovered/i);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('warns on low memory, high swap or a full disk', () => {
    const sb = makeSandbox({
      ...API,
      free: 'Mem: 954 900 10 10 44 50\nSwap: 4095 3000 1095',
      df: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 50000000 45000000 5000000 90% /',
    });
    try {
      const r = runStatus(sb);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^warn /);
      assert.match(r.stdout, /mem_avail=5%/);
      assert.match(r.stdout, /swap_used=73%/);
      assert.match(r.stdout, /disk_used=90%/);
      assert.equal(JSON.parse(posted(sb)[0]).embeds[0].color, 0xf5a524);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('fails when readiness is not 200 and placement is disabled', () => {
    const sb = makeSandbox({
      ...API,
      ready: 503,
      trading:
        '{"placement":false,"cancellation":true,"fx":false,"reasons":["MARKET_DATA"]}',
    });
    try {
      const r = runStatus(sb);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^fail .*ready=503.*placement=false/);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('is a silent no-op for the webhook when DISCORD_WEBHOOK_URL is absent', () => {
    const sb = makeSandbox(API);
    try {
      const r = runStatus(sb, { DISCORD_WEBHOOK_URL: '' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^ok /);
      assert.equal(posted(sb).length, 0);
      assert.ok(existsSync(sb.state), 'state is still recorded');
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

describe('notify.sh', () => {
  it('posts a Discord embed and never echoes the webhook URL', () => {
    const sb = makeSandbox(API);
    try {
      const r = spawnSync(
        'bash',
        [notify, 'warn', 'hello title', 'some body'],
        {
          env: {
            PATH: `${sb.bin}:${process.env.PATH}`,
            DISCORD_WEBHOOK_URL: WEBHOOK,
          },
          encoding: 'utf8',
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes(WEBHOOK));
      const body = JSON.parse(posted(sb)[0]);
      assert.equal(body.embeds[0].title, 'hello title');
      assert.equal(body.embeds[0].description, 'some body');
      assert.equal(body.embeds[0].color, 0xf5a524);
      assert.match(
        body.embeds[0].footer.text,
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/,
      );
      assert.ok(!JSON.stringify(body).includes(WEBHOOK));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('exits 0 without calling curl when the webhook is unset', () => {
    const sb = makeSandbox(API);
    try {
      const r = spawnSync('bash', [notify, 'ok', 'x'], {
        env: { PATH: `${sb.bin}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
      assert.equal(posted(sb).length, 0);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('exits 0 even when the webhook rejects the post', () => {
    const sb = makeSandbox(API);
    try {
      writeFileSync(join(sb.bin, 'curl'), '#!/usr/bin/env bash\nexit 22\n');
      chmodSync(join(sb.bin, 'curl'), 0o755);
      const r = spawnSync('bash', [notify, 'fail', 'x'], {
        env: {
          PATH: `${sb.bin}:${process.env.PATH}`,
          DISCORD_WEBHOOK_URL: WEBHOOK,
        },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /notify: post failed/);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown level', () => {
    const r = spawnSync('bash', [notify, 'loud', 'x'], {
      env: { PATH: process.env.PATH, DISCORD_WEBHOOK_URL: WEBHOOK },
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
  });
});
