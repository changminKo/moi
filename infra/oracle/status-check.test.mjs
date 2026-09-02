// Behavioural tests for infra/oracle/{status-check,notify,deploy-lib}.sh.
// Every collector is stubbed through environment variables and a fake `curl`
// placed first on PATH records what would have been posted to Discord.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const statusCheck = resolve(here, 'status-check.sh');
const notify = resolve(here, 'notify.sh');
const deployLib = resolve(here, 'deploy-lib.sh');
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
// the webhook POST (URL arrives via `-K -` on stdin). It routes on the URL and
// appends every POST body to a log. FAKE_CURL_FAIL_POST=1 rejects posts,
// FAKE_CURL_API_DOWN=1 makes every API probe exit 7 with no output.
function makeSandbox(api) {
  const dir = mkdtempSync(join(tmpdir(), 'moi-status-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const posts = join(dir, 'posts.log');
  const fakeCurl = `#!/usr/bin/env bash
url=""; data=""; write_out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--data|--data-binary) data="$2"; shift 2;;
    -w|--write-out) write_out="$2"; shift 2;;
    -K|--config) cfg="$(cat)"; url="$(printf '%s\\n' "$cfg" | sed -n 's/^url = "\\(.*\\)"$/\\1/p')"; shift 2;;
    -o|--output|-H|--header|--max-time|-X) shift 2;;
    -*) shift;;
    *) url="$1"; shift;;
  esac
done
if [ -n "$data" ]; then
  [ "\${FAKE_CURL_FAIL_POST:-0}" = 1 ] && exit 22
  printf '%s\\n' "$url" >> "${posts}.urls"
  printf '%s\\n' "$data" >> "${posts}"; exit 0
fi
[ "\${FAKE_CURL_API_DOWN:-0}" = 1 ] && exit 7
case "$url" in
  */health/ready) [ -n "$write_out" ] && printf '%s' "${api.ready}"; [ "${api.ready}" = 200 ] || exit 22;;
  */health/market-data) printf '%s' '${api.marketData}';;
  */api/v1/health/trading) printf '%s' '${api.trading}';;
  *) echo "unexpected url $url" >&2; exit 7;;
esac
`;
  const stub = (name, body) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  stub('curl', fakeCurl);
  stub(
    'docker',
    `#!/usr/bin/env bash
if [ "\${1:-}" != image ] || [ "\${2:-}" != inspect ]; then
  echo "unexpected docker call: $*" >&2
  exit 2
fi
image="\${!#}"
case "$image" in
  ghcr.io/changminko/moi-paper-api:*) printf '%s' "\${FAKE_DOCKER_PAPER_API_REVISION:-}";;
  ghcr.io/changminko/moi-web:*) printf '%s' "\${FAKE_DOCKER_WEB_REVISION:-}";;
  ghcr.io/changminko/moi-strategy-runner:*) printf '%s' "\${FAKE_DOCKER_BOT_REVISION:-}";;
  *) echo "unexpected image: $image" >&2; exit 2;;
esac
`,
  );
  stub(
    'flock',
    `#!/usr/bin/env bash
lock="\${MOI_DEPLOY_MUTEX}.held"
case "\${1:-}" in
  -n)
    if mkdir "$lock" 2>/dev/null; then
      printf '%s' "$PPID" > "$lock/owner"
      exit 0
    fi
    [ "$(cat "$lock/owner" 2>/dev/null)" = "$PPID" ]
    ;;
  -u)
    if [ "$(cat "$lock/owner" 2>/dev/null)" = "$PPID" ]; then
      rm -rf "$lock"
    fi
    ;;
  *) exit 2;;
esac
`,
  );
  stub(
    'free',
    `#!/usr/bin/env bash\nprintf '%s\\n' '${api.free.replace(/\n/g, "' '")}'\n`,
  );
  stub(
    'df',
    `#!/usr/bin/env bash\nprintf '%s\\n' '${api.df.replace(/\n/g, "' '")}'\n`,
  );
  return { dir, bin, posts, state: join(dir, 'status.last') };
}

function runStatus(sb, extraEnv = {}) {
  return spawnSync('bash', [statusCheck], {
    env: {
      PATH: `${sb.bin}:${process.env.PATH}`,
      HOME: sb.dir,
      MOI_STATUS_API_BASE: 'https://api.moi.example',
      MOI_STATUS_STATE_FILE: sb.state,
      MOI_STATUS_DEPLOY_LOCK: join(sb.dir, 'deploy.lock'),
      MOI_STATUS_NOW: '1000000000',
      DISCORD_WEBHOOK_URL: WEBHOOK,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function posted(sb) {
  return existsSync(sb.posts)
    ? readFileSync(sb.posts, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}
const embed = (json) => JSON.parse(json).embeds[0];
const stateLines = (sb) => readFileSync(sb.state, 'utf8').trim().split('\n');

describe('status-check.sh', () => {
  it('reports ok, posts the first observation, then stays quiet while unchanged', () => {
    const sb = makeSandbox(API);
    try {
      const first = runStatus(sb);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /^ok /);
      assert.equal(posted(sb).length, 1, 'first observation is announced once');
      assert.deepEqual(stateLines(sb)[1], '1000000000', 'post epoch recorded');
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

  it('ignores drifting percentages and posts only when a threshold flips', () => {
    const sb = makeSandbox(API);
    const setFree = (text) =>
      writeFileSync(
        join(sb.bin, 'free'),
        `#!/usr/bin/env bash\nprintf '%s\\n' '${text.replace(/\n/g, "' '")}'\n`,
      );
    try {
      assert.equal(runStatus(sb).status, 0);
      assert.equal(posted(sb).length, 1);
      // Same level, memory drifts 600 -> 580 -> 610 MB available: still ok.
      setFree('Mem: 954 420 90 10 444 580\nSwap: 4095 100 3995');
      assert.equal(runStatus(sb).status, 0);
      setFree('Mem: 954 390 110 10 454 610\nSwap: 4095 100 3995');
      assert.equal(runStatus(sb).status, 0);
      assert.equal(posted(sb).length, 1, 'drifting numbers must not post');
      assert.match(stateLines(sb)[0], /^ok .* mem=ok swap=ok disk=ok$/);
      // Crossing the threshold is a real change.
      setFree('Mem: 954 900 10 10 44 50\nSwap: 4095 100 3995');
      const warn = runStatus(sb);
      assert.equal(warn.status, 0, warn.stderr);
      assert.match(warn.stdout, /^warn /);
      assert.equal(posted(sb).length, 2, 'threshold breach posts once');
      assert.equal(runStatus(sb).status, 0);
      assert.equal(posted(sb).length, 2, 'sustained breach stays quiet');
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
      assert.equal(embed(degradedPosts[0]).color, 0xe5484d);
      assert.match(embed(degradedPosts[0]).title, /status FAIL/i);
      rmSync(degraded.dir, { recursive: true, force: true });

      const recovered = runStatus(sb);
      assert.match(recovered.stdout, /^ok /);
      const all = posted(sb);
      assert.equal(all.length, 2, 'recovery is announced');
      assert.match(embed(all[1]).title, /recovered/i);
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
      assert.equal(embed(posted(sb)[0]).color, 0xf5a524);
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

  it('fails closed when the API edge is unreachable', () => {
    const sb = makeSandbox(API);
    try {
      const r = runStatus(sb, { FAKE_CURL_API_DOWN: '1' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        /^fail ready=000 runtime=unknown KR=unknown US=unknown placement=unknown/,
      );
      assert.equal(posted(sb).length, 1);
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

  it('keeps the transition pending while Discord rejects the post, then delivers it', () => {
    const sb = makeSandbox(API);
    try {
      const r1 = runStatus(sb, { FAKE_CURL_FAIL_POST: '1' });
      assert.equal(r1.status, 0);
      assert.match(r1.stderr, /post failed, will retry next tick/);
      assert.ok(
        !existsSync(sb.state),
        'state must not be recorded without delivery',
      );
      assert.ok(!(r1.stdout + r1.stderr).includes(WEBHOOK));
      const r2 = runStatus(sb);
      assert.equal(r2.status, 0, r2.stderr);
      assert.equal(posted(sb).length, 1, 'retried on the next tick');
      assert.ok(existsSync(sb.state));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('sends a heartbeat when nothing was delivered for the configured window', () => {
    const sb = makeSandbox(API);
    try {
      runStatus(sb); // delivered at epoch 1000000000
      const quiet = runStatus(sb, {
        MOI_STATUS_NOW: String(1000000000 + 23 * 3600),
      });
      assert.equal(quiet.status, 0);
      assert.equal(posted(sb).length, 1, 'inside the window: nothing');
      const due = runStatus(sb, {
        MOI_STATUS_NOW: String(1000000000 + 24 * 3600),
      });
      assert.equal(due.status, 0, due.stderr);
      const all = posted(sb);
      assert.equal(all.length, 2, 'heartbeat posted');
      assert.match(embed(all[1]).title, /heartbeat/i);
      assert.equal(embed(all[1]).color, 0x2ecc71);
      assert.equal(stateLines(sb)[1], String(1000000000 + 24 * 3600));
      const again = runStatus(sb, {
        MOI_STATUS_NOW: String(1000000000 + 25 * 3600),
      });
      assert.equal(again.status, 0);
      assert.equal(posted(sb).length, 2, 'heartbeat clock restarted');
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('stays silent and leaves the state alone while a deploy holds a fresh lock', () => {
    const sb = makeSandbox(API);
    try {
      writeFileSync(join(sb.dir, 'deploy.lock'), '');
      const r = runStatus(sb, {
        MOI_STATUS_NOW: String(Math.floor(Date.now() / 1000)),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.equal(posted(sb).length, 0);
      assert.ok(!existsSync(sb.state));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('ignores a stale deploy lock left by a deploy that died without its trap', () => {
    const sb = makeSandbox(API);
    try {
      const lock = join(sb.dir, 'deploy.lock');
      writeFileSync(lock, '');
      const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
      utimesSync(lock, threeHoursAgo, threeHoursAgo);
      const r = runStatus(sb, {
        MOI_STATUS_NOW: String(Math.floor(Date.now() / 1000)),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /ignoring stale deploy lock/);
      assert.match(r.stdout, /^ok /);
      assert.equal(posted(sb).length, 1, 'status still posted');
      assert.ok(existsSync(sb.state));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('heartbeats with the current level, not a hardcoded ok', () => {
    const sb = makeSandbox({
      ...API,
      marketData: API.marketData.replace(
        '"KR":{"state":"NORMAL"',
        '"KR":{"state":"DEGRADED"',
      ),
    });
    try {
      runStatus(sb); // FAIL delivered at epoch 1000000000
      const due = runStatus(sb, {
        MOI_STATUS_NOW: String(1000000000 + 25 * 3600),
      });
      assert.equal(due.status, 0, due.stderr);
      const all = posted(sb);
      assert.equal(all.length, 2);
      assert.match(embed(all[1]).title, /heartbeat \(fail\)/);
      assert.equal(embed(all[1]).color, 0xe5484d);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

describe('notify.sh', () => {
  const runNotify = (sb, args, env = {}) =>
    spawnSync('bash', [notify, ...args], {
      env: {
        PATH: `${sb.bin}:${process.env.PATH}`,
        DISCORD_WEBHOOK_URL: WEBHOOK,
        ...env,
      },
      encoding: 'utf8',
    });

  it('posts a Discord embed, passes the URL on stdin and never echoes it', () => {
    const sb = makeSandbox(API);
    try {
      const r = runNotify(sb, ['warn', 'hello title', 'some body']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!(r.stdout + r.stderr).includes(WEBHOOK));
      const body = embed(posted(sb)[0]);
      assert.equal(body.title, 'hello title');
      assert.equal(body.description, 'some body');
      assert.equal(body.color, 0xf5a524);
      assert.match(body.footer.text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
      assert.ok(!JSON.stringify(body).includes(WEBHOOK));
      assert.equal(
        readFileSync(`${sb.posts}.urls`, 'utf8').trim(),
        WEBHOOK,
        'curl received the URL through -K -',
      );
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('masks credentials, secret assignments and webhook URLs before posting', () => {
    const sb = makeSandbox(API);
    try {
      const leak = [
        'DATABASE_URL=postgres://moi:pw-secret-123@postgres:5432/moi',
        'TOSS_CLIENT_SECRET=abcDEF123',
        'ADMIN_API_KEY: zzz999',
        'api token=lower-case-tok',
        'hook https://discord.com/api/webhooks/1234567890/AbC-def_GHI',
        'plain line stays',
      ].join('\n');
      const r = runNotify(sb, ['fail', 'moi.service failed', leak]);
      assert.equal(r.status, 0, r.stderr);
      const text = embed(posted(sb)[0]).description;
      assert.ok(!text.includes('pw-secret-123'));
      assert.ok(!text.includes('abcDEF123'));
      assert.ok(!text.includes('zzz999'));
      assert.ok(!text.includes('1234567890'));
      assert.ok(!text.includes('lower-case-tok'));
      assert.match(text, /api token=\*\*\*/);
      assert.match(text, /postgres:\/\/moi:\*\*\*@postgres:5432\/moi/);
      assert.match(text, /TOSS_CLIENT_SECRET=\*\*\*/);
      assert.match(text, /ADMIN_API_KEY: \*\*\*/);
      assert.match(text, /hook <webhook>/);
      assert.match(text, /plain line stays/);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('caps the description at 1500 characters', () => {
    const sb = makeSandbox(API);
    try {
      const r = runNotify(sb, ['info', 't', 'x'.repeat(4000)]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(embed(posted(sb)[0]).description.length, 1500);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('exits 0 without calling curl when the webhook is unset', () => {
    const sb = makeSandbox(API);
    try {
      const r = runNotify(sb, ['ok', 'x'], { DISCORD_WEBHOOK_URL: '' });
      assert.equal(r.status, 0);
      assert.equal(posted(sb).length, 0);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('exits 0 by default when the webhook rejects the post, 1 under NOTIFY_STRICT', () => {
    const sb = makeSandbox(API);
    try {
      const soft = runNotify(sb, ['fail', 'x'], { FAKE_CURL_FAIL_POST: '1' });
      assert.equal(soft.status, 0);
      assert.match(soft.stderr, /notify: post failed/);
      assert.ok(!(soft.stdout + soft.stderr).includes(WEBHOOK));
      const strict = runNotify(sb, ['fail', 'x'], {
        FAKE_CURL_FAIL_POST: '1',
        NOTIFY_STRICT: '1',
      });
      assert.equal(strict.status, 1);
      assert.match(strict.stderr, /notify: post failed/);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('exits 0 with a message and no curl call when jq is missing', () => {
    const sb = makeSandbox(API);
    try {
      // A PATH that has the fake curl plus only the tools notify.sh needs, no jq.
      const nojq = join(sb.dir, 'nojq');
      mkdirSync(nojq);
      for (const tool of [
        'bash',
        'sed',
        'head',
        'hostname',
        'date',
        'cat',
        'tr',
      ]) {
        const real = spawnSync('bash', ['-lc', `command -v ${tool}`], {
          encoding: 'utf8',
        }).stdout.trim();
        symlinkSync(real, join(nojq, tool));
      }
      const r = spawnSync('bash', [notify, 'fail', 'x'], {
        env: { PATH: `${sb.bin}:${nojq}`, DISCORD_WEBHOOK_URL: WEBHOOK },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /notify: jq missing/);
      assert.equal(posted(sb).length, 0);
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

describe('status-check.sh bot probe (phase D)', () => {
  it('ignores the bot when the profile is off', () => {
    const sb = makeSandbox(API);
    try {
      const r = runStatus(sb);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^ok .* bot=n\/a /);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('is ok with a steadily running bot and fails on a restart loop', () => {
    const sb = makeSandbox(API);
    try {
      const up = runStatus(sb, {
        COMPOSE_PROFILES: 'bot',
        MOI_STATUS_BOT_STATE: 'running 0',
      });
      assert.equal(up.status, 0, up.stderr);
      assert.match(up.stdout, /^ok .* bot=running\/0 /);

      const looping = runStatus(sb, {
        COMPOSE_PROFILES: 'bot',
        MOI_STATUS_BOT_STATE: 'restarting 7',
      });
      assert.equal(looping.status, 0, looping.stderr);
      assert.match(looping.stdout, /^fail .* bot=restarting\/7 /);
      assert.equal(posted(sb).length, 2, 'the flip to fail is announced');
      assert.equal(embed(posted(sb)[1]).title, 'Moi status FAIL');
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('fails when the profile is on but no bot container exists', () => {
    const sb = makeSandbox(API);
    try {
      const r = runStatus(sb, {
        COMPOSE_PROFILES: 'bot',
        MOI_STATUS_BOT_STATE: 'missing -1',
      });
      assert.match(r.stdout, /^fail .* bot=missing\/-1 /);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

describe('deploy-lib.sh', () => {
  function waitForFile(path) {
    return new Promise((resolvePromise, rejectPromise) => {
      const deadline = Date.now() + 5_000;
      const tick = setInterval(() => {
        if (existsSync(path)) {
          clearInterval(tick);
          resolvePromise();
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(tick);
          rejectPromise(new Error(`timed out waiting for ${path}`));
        }
      }, 25);
    });
  }

  // A stand-in for deploy.sh: sources the library and runs `body`.
  function runDeploy(sb, body, { signal, extraEnv = {} } = {}) {
    const script = join(sb.dir, 'deploy-under-test.sh');
    writeFileSync(
      script,
      `#!/usr/bin/env bash\nset -euo pipefail\nREPO=${JSON.stringify(here)}\n. ${JSON.stringify(deployLib)}\n${body}\n`,
    );
    const env = {
      PATH: `${sb.bin}:${process.env.PATH}`,
      DISCORD_WEBHOOK_URL: WEBHOOK,
      NOTIFY_BIN: notify,
      MOI_DEPLOY_LOCK: join(sb.dir, 'deploy.lock'),
      MOI_DEPLOY_MUTEX: join(sb.dir, 'deploy.mutex'),
      MOI_DEPLOY_MANAGE_TIMER: '0',
      ...extraEnv,
    };
    if (!signal) return spawnSync('bash', [script], { env, encoding: 'utf8' });
    return new Promise((done) => {
      const child = spawn('bash', [script], { env, detached: true });
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      // Wait until the body signals it passed its `step`, then interrupt.
      const tick = setInterval(() => {
        if (existsSync(`${env.MOI_DEPLOY_LOCK}.ready`)) {
          clearInterval(tick);
          process.kill(-child.pid, signal);
        }
      }, 50);
      child.on('exit', (code, sig) => {
        // A background child inherits SIGINT as ignored. Once the shell has
        // reported the trap's exit code, remove anything still holding the
        // detached test process group's pipes open.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        done({ status: code, signal: sig, stderr });
      });
    });
  }
  const titles = (sb) => posted(sb).map((p) => embed(p).title);

  /**
   * `bot_steady` is the deploy's answer to a runner in a restart loop: one
   * `running` is not enough, it has to hold with RestartCount 0.
   */
  it('bot_steady needs consecutive running/0 polls and fails a restart loop', () => {
    const sb = makeSandbox(API);
    try {
      const probe = join(sb.dir, 'probe.sh');
      const seq = join(sb.dir, 'seq');
      writeFileSync(
        probe,
        `#!/usr/bin/env bash\nline="$(head -n1 ${JSON.stringify(seq)})"\ntail -n +2 ${JSON.stringify(seq)} > ${JSON.stringify(seq)}.tmp && mv ${JSON.stringify(seq)}.tmp ${JSON.stringify(seq)}\nprintf '%s\\n' "\${line:-running 0}"\n`,
      );
      chmodSync(probe, 0o755);
      const body = `deploy_begin main\nstep verify\nif MOI_BOT_STEADY_SLEEP=0 MOI_BOT_STEADY_POLLS=3 MOI_BOT_STEADY_MAX=6 bot_steady ${JSON.stringify(probe)}; then echo STEADY; else echo LOOPING; fi\ndeploy_verified x\nexit 0`;

      writeFileSync(
        seq,
        'running 0\nrestarting 1\nrunning 1\nrunning 1\nrunning 1\nrunning 1\n',
      );
      const looping = runDeploy(sb, body);
      assert.equal(looping.status, 0, looping.stderr);
      assert.match(looping.stdout, /LOOPING/);

      writeFileSync(seq, 'running 0\nrunning 0\nrunning 0\n');
      const steady = runDeploy(sb, body);
      assert.equal(steady.status, 0, steady.stderr);
      assert.match(steady.stdout, /STEADY/);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('reports success only after deploy_verified and removes the lock', () => {
    const sb = makeSandbox(API);
    try {
      const r = runDeploy(
        sb,
        'deploy_begin main\nstep verify\ndeploy_verified abc1234\nexit 0',
      );
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(titles(sb), [
        'deploy started: main',
        'deploy finished: abc1234',
      ]);
      assert.ok(!existsSync(join(sb.dir, 'deploy.lock')));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('turns an exit 0 that never reached verification into exit 1 with a fail alert', () => {
    const sb = makeSandbox(API);
    try {
      const r = runDeploy(sb, 'deploy_begin main\nstep migrations\nexit 0');
      assert.equal(r.status, 1);
      const all = posted(sb);
      assert.deepEqual(titles(sb), [
        'deploy started: main',
        'deploy failed: main',
      ]);
      assert.match(embed(all[1]).description, /step: migrations \(exit 1\)/);
      assert.ok(!existsSync(join(sb.dir, 'deploy.lock')));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('reports the failing step when a command fails under set -e', () => {
    const sb = makeSandbox(API);
    try {
      const r = runDeploy(
        sb,
        'deploy_begin main\nstep "preflight (production)"\nfalse',
      );
      assert.equal(r.status, 1);
      assert.match(
        embed(posted(sb)[1]).description,
        /step: preflight \(production\) \(exit 1\)/,
      );
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('fails clearly without touching deploy state when flock is unavailable', () => {
    const sb = makeSandbox(API);
    try {
      rmSync(join(sb.bin, 'flock'));

      const r = runDeploy(sb, 'deploy_begin main');

      assert.equal(r.status, 69, r.stderr);
      assert.match(r.stderr, /flock is required to serialize deploys/u);
      assert.ok(!existsSync(join(sb.dir, 'deploy.lock')));
      assert.deepEqual(posted(sb), []);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('rejects a concurrent deploy without touching the active deploy marker or running its body', async () => {
    const sb = makeSandbox(API);
    const holderScript = join(sb.dir, 'deploy-holder.sh');
    const activeMarker = join(sb.dir, 'deploy.lock');
    const holderReady = `${activeMarker}.holder-ready`;
    const rejectedBody = `${activeMarker}.rejected-body-ran`;
    const env = {
      PATH: `${sb.bin}:${process.env.PATH}`,
      DISCORD_WEBHOOK_URL: WEBHOOK,
      NOTIFY_BIN: notify,
      MOI_DEPLOY_LOCK: activeMarker,
      MOI_DEPLOY_MUTEX: join(sb.dir, 'deploy.mutex'),
      MOI_DEPLOY_MANAGE_TIMER: '0',
    };
    writeFileSync(
      holderScript,
      `#!/usr/bin/env bash
set -euo pipefail
REPO=${JSON.stringify(here)}
. ${JSON.stringify(deployLib)}
deploy_begin first
: > ${JSON.stringify(holderReady)}
sleep 30 &
wait
`,
    );
    const holder = spawn('bash', [holderScript], { env, detached: true });
    const holderExit = new Promise((resolvePromise) => {
      holder.on('exit', (code, signal) => resolvePromise({ code, signal }));
    });

    try {
      await waitForFile(holderReady);
      assert.ok(existsSync(activeMarker), 'the active deploy owns the marker');

      const rejected = runDeploy(
        sb,
        `deploy_begin second
: > ${JSON.stringify(rejectedBody)}`,
      );

      assert.equal(rejected.status, 75, rejected.stderr);
      assert.match(rejected.stderr, /another deploy is already in progress/u);
      assert.ok(
        !existsSync(rejectedBody),
        'a rejected deploy must not run commands after deploy_begin',
      );
      assert.ok(
        existsSync(activeMarker),
        'a rejected deploy must not remove the active deploy marker',
      );
    } finally {
      if (holder.exitCode === null) process.kill(-holder.pid, 'SIGTERM');
      await holderExit;
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('re-execs the freshly checked-out deploy script once while preserving the active mutex', () => {
    const sb = makeSandbox(API);
    const oldScript = join(sb.dir, 'old-deploy.sh');
    const freshSource = join(sb.dir, 'fresh-source.sh');
    const checkedOutScript = join(sb.dir, 'checkout', 'deploy.sh');
    const oldTail = join(sb.dir, 'old-tail-ran');
    const freshBody = join(sb.dir, 'fresh-body-ran');
    mkdirSync(dirname(checkedOutScript), { recursive: true });
    const env = {
      PATH: `${sb.bin}:${process.env.PATH}`,
      DISCORD_WEBHOOK_URL: WEBHOOK,
      NOTIFY_BIN: notify,
      MOI_DEPLOY_LOCK: join(sb.dir, 'deploy.lock'),
      MOI_DEPLOY_MUTEX: join(sb.dir, 'deploy.mutex'),
      MOI_DEPLOY_MANAGE_TIMER: '0',
    };
    writeFileSync(
      freshSource,
      `#!/usr/bin/env bash
set -euo pipefail
REPO=${JSON.stringify(here)}
. ${JSON.stringify(deployLib)}
deploy_begin "$1"
deploy_reexec "$0" "$1"
: > ${JSON.stringify(freshBody)}
deploy_verified fresh123
`,
    );
    chmodSync(freshSource, 0o755);
    writeFileSync(
      oldScript,
      `#!/usr/bin/env bash
set -euo pipefail
REPO=${JSON.stringify(here)}
. ${JSON.stringify(deployLib)}
deploy_begin main
cp ${JSON.stringify(freshSource)} ${JSON.stringify(checkedOutScript)}
deploy_reexec ${JSON.stringify(checkedOutScript)} main
: > ${JSON.stringify(oldTail)}
`,
    );

    try {
      const r = spawnSync('bash', [oldScript], {
        env,
        encoding: 'utf8',
        timeout: 5_000,
      });

      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(freshBody), 'the checked-out script body must run');
      assert.ok(
        !existsSync(oldTail),
        'the pre-fetch script body must not resume',
      );
      assert.deepEqual(titles(sb), [
        'deploy started: main',
        'deploy finished: fresh123',
      ]);
      assert.ok(!existsSync(env.MOI_DEPLOY_LOCK));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('rejects a forged re-exec guard without an inherited mutex descriptor', () => {
    const sb = makeSandbox(API);
    const marker = join(sb.dir, 'deploy.lock');
    writeFileSync(marker, 'owned elsewhere');
    try {
      const r = runDeploy(sb, 'deploy_begin main', {
        extraEnv: { MOI_DEPLOY_REEXEC: '1' },
      });

      assert.equal(r.status, 70, r.stderr);
      assert.match(r.stderr, /re-exec lost its inherited mutex/u);
      assert.equal(readFileSync(marker, 'utf8'), 'owned elsewhere');
      assert.deepEqual(posted(sb), []);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('rejects a release image whose revision differs from the checked-out commit', () => {
    const sb = makeSandbox(API);
    const expected = 'a'.repeat(40);
    const actual = 'b'.repeat(40);
    try {
      const r = runDeploy(
        sb,
        `deploy_begin main
verify_release_image_revisions ${expected} \
  ghcr.io/changminko/moi-paper-api:main \
  ghcr.io/changminko/moi-web:main`,
        {
          extraEnv: {
            FAKE_DOCKER_PAPER_API_REVISION: expected,
            FAKE_DOCKER_WEB_REVISION: actual,
          },
        },
      );

      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /moi-web:main revision does not match checkout/u);
      assert.match(r.stderr, new RegExp(`expected ${expected}, got ${actual}`));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('rejects a release image with no OCI revision label', () => {
    const sb = makeSandbox(API);
    const expected = 'a'.repeat(40);
    try {
      const r = runDeploy(
        sb,
        `deploy_begin main
verify_release_image_revisions ${expected} \
  ghcr.io/changminko/moi-paper-api:main \
  ghcr.io/changminko/moi-web:main`,
        {
          extraEnv: {
            FAKE_DOCKER_PAPER_API_REVISION: expected,
            FAKE_DOCKER_WEB_REVISION: '',
          },
        },
      );

      assert.equal(r.status, 1, r.stderr);
      assert.match(
        r.stderr,
        /moi-web:main has no org\.opencontainers\.image\.revision label/u,
      );
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('refuses to verify fewer than the two public release images', () => {
    const sb = makeSandbox(API);
    const expected = 'a'.repeat(40);
    try {
      const r = runDeploy(
        sb,
        `deploy_begin main
verify_release_image_revisions ${expected} \
  ghcr.io/changminko/moi-paper-api:main`,
        {
          extraEnv: { FAKE_DOCKER_PAPER_API_REVISION: expected },
        },
      );

      assert.equal(r.status, 64, r.stderr);
      assert.match(
        r.stderr,
        /revision verification requires at least the two public release images/u,
      );
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('verifies the bot image too when the profile pulled it', () => {
    const sb = makeSandbox(API);
    const expected = 'a'.repeat(40);
    const stale = 'b'.repeat(40);
    try {
      const r = runDeploy(
        sb,
        `deploy_begin main
verify_release_image_revisions ${expected} \
  ghcr.io/changminko/moi-paper-api:main \
  ghcr.io/changminko/moi-web:main \
  ghcr.io/changminko/moi-strategy-runner:main`,
        {
          extraEnv: {
            FAKE_DOCKER_PAPER_API_REVISION: expected,
            FAKE_DOCKER_WEB_REVISION: expected,
            FAKE_DOCKER_BOT_REVISION: stale,
          },
        },
      );

      assert.equal(r.status, 1, r.stderr);
      assert.match(
        r.stderr,
        /moi-strategy-runner:main revision does not match checkout/u,
      );
      assert.match(r.stderr, new RegExp(`expected ${expected}, got ${stale}`));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('accepts two release images at the checked-out revision and records that revision', () => {
    const sb = makeSandbox(API);
    const expected = 'a'.repeat(40);
    try {
      const r = runDeploy(
        sb,
        `deploy_begin main
verify_release_image_revisions ${expected} \
  ghcr.io/changminko/moi-paper-api:main \
  ghcr.io/changminko/moi-web:main
deploy_verified ${expected}`,
        {
          extraEnv: {
            FAKE_DOCKER_PAPER_API_REVISION: expected,
            FAKE_DOCKER_WEB_REVISION: expected,
          },
        },
      );

      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stdout,
        new RegExp(`release images verified at ${expected}`),
      );
      assert.deepEqual(titles(sb), [
        'deploy started: main',
        `deploy finished: ${expected}`,
      ]);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('exits 130 with a fail alert on SIGINT', async () => {
    const sb = makeSandbox(API);
    try {
      const r = await runDeploy(
        sb,
        'deploy_begin main\nstep toolchain\n: > "$MOI_DEPLOY_LOCK.ready"\nsleep 30 &\nwait',
        {
          signal: 'SIGINT',
        },
      );
      assert.equal(r.status, 130, r.stderr);
      assert.deepEqual(titles(sb), [
        'deploy started: main',
        'deploy failed: main',
      ]);
      assert.match(
        embed(posted(sb)[1]).description,
        /step: toolchain \(exit 130\)/,
      );
      assert.ok(!existsSync(join(sb.dir, 'deploy.lock')));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  it('exits 143 with a fail alert on SIGTERM', async () => {
    const sb = makeSandbox(API);
    try {
      const r = await runDeploy(
        sb,
        'deploy_begin main\nstep verify\n: > "$MOI_DEPLOY_LOCK.ready"\nsleep 30 &\nwait',
        {
          signal: 'SIGTERM',
        },
      );
      assert.equal(r.status, 143, r.stderr);
      assert.match(
        embed(posted(sb)[1]).description,
        /step: verify \(exit 143\)/,
      );
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});
