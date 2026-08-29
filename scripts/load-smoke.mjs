import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HEALTHY_P95_LIMIT_MS = 500;
const CANCEL_ONLY_P95_LIMIT_MS = 1_000;

function required(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function settings(environment) {
  const baseUrl = new URL(required('LOAD_BASE_URL', environment));
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('LOAD_BASE_URL must use http or https');
  }
  const durationSeconds = Number(
    required('LOAD_DURATION_SECONDS', environment),
  );
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('LOAD_DURATION_SECONDS must be a positive number');
  }
  return {
    baseUrl,
    durationMs: durationSeconds * 1_000,
    adminToken: required('LOAD_ADMIN_TOKEN', environment),
  };
}

function serverDuration(response) {
  const header = response.headers.get('server-timing') ?? '';
  const match = /(?:^|,)\s*app;dur=(\d+(?:\.\d+)?)(?:,|$)/.exec(header);
  if (!match) throw new Error('response omitted Server-Timing app duration');
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('response contained an invalid server duration');
  }
  return value;
}

function percentile95(values) {
  if (values.length === 0) throw new Error('cannot calculate p95 without data');
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

async function json(response, operation) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${operation} returned non-JSON (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(
      `${operation} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function bootstrap(baseUrl, fetchImpl) {
  const response = await fetchImpl(
    new URL('/api/v1/sessions/anonymous', baseUrl),
    {
      method: 'POST',
      headers: { origin: baseUrl.origin },
    },
  );
  const body = await json(response, 'anonymous session bootstrap');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie || typeof body.csrfToken !== 'string') {
    throw new Error('anonymous session bootstrap omitted cookie or CSRF token');
  }
  return { cookie, csrfToken: body.csrfToken };
}

async function mutate(baseUrl, fetchImpl, session, path, method, body) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: {
      origin: baseUrl.origin,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      'idempotency-key': randomUUID(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const duration = serverDuration(response);
  return { body: await json(response, `${method} ${path}`), duration };
}

async function admin(baseUrl, fetchImpl, token, path, body) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return await json(response, `POST ${path}`);
}

export async function runLoadSmoke({
  environment = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const { baseUrl, durationMs, adminToken } = settings(environment);
  const placements = [];
  const cancellations = [];
  const orders = [];
  let incident;
  let primaryError;
  let result;
  const cleanupErrors = [];
  const deadline = now() + durationMs;
  const placementDeadline = now() + durationMs / 2;

  try {
    do {
      const session = await bootstrap(baseUrl, fetchImpl);
      const placed = await mutate(
        baseUrl,
        fetchImpl,
        session,
        '/api/v1/orders',
        'POST',
        {
          market: 'KR',
          symbol: '005930',
          side: 'BUY',
          type: 'LIMIT',
          quantity: '1',
          limitPrice: '1',
        },
      );
      if (typeof placed.body.id !== 'string') {
        throw new Error('order placement omitted its order id');
      }
      placements.push(placed.duration);
      orders.push({ id: placed.body.id, session });
    } while (now() < placementDeadline);

    incident = await admin(baseUrl, fetchImpl, adminToken, '/admin/incidents', {
      reason: 'Task 9 release load smoke',
      scope: { type: 'GLOBAL', id: 'global' },
      denied: ['PLACE', 'AMEND', 'MATCH', 'TRIGGER', 'RECOVER'],
      causeCode: 'LOAD_SMOKE_CANCEL_ONLY',
      recoveryEpoch: null,
    });

    let index = 0;
    do {
      const order = orders[index % orders.length];
      const cancelled = await mutate(
        baseUrl,
        fetchImpl,
        order.session,
        `/api/v1/orders/${encodeURIComponent(order.id)}`,
        'DELETE',
      );
      cancellations.push(cancelled.duration);
      index += 1;
    } while (now() < deadline && index < orders.length);

    const healthyP95Ms = percentile95(placements);
    const cancelOnlyP95Ms = percentile95(cancellations);
    if (healthyP95Ms > HEALTHY_P95_LIMIT_MS) {
      throw new Error(
        `healthy order mutation p95 ${healthyP95Ms}ms exceeds ${HEALTHY_P95_LIMIT_MS}ms`,
      );
    }
    if (cancelOnlyP95Ms > CANCEL_ONLY_P95_LIMIT_MS) {
      throw new Error(
        `cancel-only cancellation p95 ${cancelOnlyP95Ms}ms exceeds ${CANCEL_ONLY_P95_LIMIT_MS}ms`,
      );
    }
    result = {
      placementSamples: placements.length,
      cancellationSamples: cancellations.length,
      healthyP95Ms,
      cancelOnlyP95Ms,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await admin(baseUrl, fetchImpl, adminToken, '/admin/cancel-all', {
        reason: 'Task 9 load smoke cleanup',
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (
      incident &&
      typeof incident.incidentId === 'string' &&
      incident.version !== undefined
    ) {
      try {
        await admin(
          baseUrl,
          fetchImpl,
          adminToken,
          `/admin/incidents/${encodeURIComponent(incident.incidentId)}/resolve`,
          { expectedVersion: incident.version, recoveryEpoch: null },
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (primaryError !== undefined) {
    for (const error of cleanupErrors) {
      console.error('[load-smoke] cleanup failure', error);
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'load smoke cleanup failed');
  }
  if (result === undefined) throw new Error('load smoke produced no result');
  return result;
}

const invokedAsProgram =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsProgram) {
  runLoadSmoke()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(`[load-smoke] ${error.message}`);
      process.exitCode = 1;
    });
}
