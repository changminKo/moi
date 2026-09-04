/**
 * Runs *inside the previous paper-api image* (#46). The host test bind-mounts
 * this file read-only and overrides the image command with `node <this file>`,
 * so everything below executes the old release's compiled production code
 * from `/app/apps/paper-api/dist` against a database the *current* checkout
 * has already migrated. Nothing from the current source is imported here, and
 * the file stays plain JavaScript so any previous image can run it.
 *
 * Scenario: anonymous session → deterministic KR order book → MARKET BUY →
 * the previous API reports the order FILLED, which its fill persistence only
 * does after the `fills` insert committed. On success the process prints
 * `SCHEMA_COMPAT_WRITE_OK` and exits 0; any failure exits nonzero with the
 * reason on stderr. The environment is never printed.
 */
import { randomUUID } from 'node:crypto';

const PREVIOUS_DIST = '/app/apps/paper-api/dist';
const SUCCESS_MARKER = 'SCHEMA_COMPAT_WRITE_OK';
const FAILURE_MARKER = 'SCHEMA_COMPAT_WRITE_FAILED';
const MARKET = 'KR';
const SYMBOL = '005930';
const ASK = { price: '70000', volume: '10' };
const BID = { price: '69900', volume: '10' };
const QUANTITY = '1';
const POLL_INTERVAL_MS = 100;
const BOOK_TIMEOUT_MS = 15_000;
const FILL_TIMEOUT_MS = 30_000;
/** Hard ceiling for the whole run, including `runtime.stop()`. */
const RUNNER_BUDGET_MS = 120_000;
const TERMINAL_STATUSES = new Set([
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function importPreviousRelease() {
  const [config, runtime, providers] = await Promise.all([
    import(`${PREVIOUS_DIST}/config.js`),
    import(`${PREVIOUS_DIST}/runtime/production-runtime.js`),
    import(`${PREVIOUS_DIST}/runtime/provider-bundle.js`),
  ]);
  for (const [name, value] of [
    ['loadConfig', config.loadConfig],
    ['ProductionRuntime', runtime.ProductionRuntime],
    ['createFakeProviderBundle', providers.createFakeProviderBundle],
  ]) {
    if (typeof value !== 'function')
      throw new Error(`previous image does not export ${name}`);
  }
  return {
    loadConfig: config.loadConfig,
    ProductionRuntime: runtime.ProductionRuntime,
    createFakeProviderBundle: providers.createFakeProviderBundle,
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function failResponse(step, response, body) {
  return new Error(
    `${step}: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`,
  );
}

async function openAnonymousSession(origin, publicOrigin) {
  const response = await fetch(`${origin}/api/v1/sessions/anonymous`, {
    method: 'POST',
    headers: { origin: publicOrigin },
  });
  const body = await readJson(response);
  if (!response.ok) throw failResponse('anonymous session', response, body);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie || typeof body.csrfToken !== 'string')
    throw new Error('anonymous session returned no cookie or CSRF token');
  return {
    headers: {
      origin: publicOrigin,
      cookie,
      'x-csrf-token': body.csrfToken,
      'content-type': 'application/json',
    },
  };
}

function emitOrderBook(bundle) {
  bundle.streamFor(MARKET).emitOrderBook({
    market: MARKET,
    symbol: SYMBOL,
    book: {
      market: MARKET,
      symbol: SYMBOL,
      currency: 'KRW',
      asks: [ASK],
      bids: [BID],
    },
    sourceTimestamp: null,
  });
}

async function pollUntil(step, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined) return result;
    if (Date.now() >= deadline)
      throw new Error(`${step}: not observed within ${timeoutMs} ms`);
    await sleep(POLL_INTERVAL_MS);
  }
}

async function waitForOrderBook(origin, session) {
  await pollUntil(
    'order book on the public quote',
    BOOK_TIMEOUT_MS,
    async () => {
      const response = await fetch(
        `${origin}/api/v1/markets/${MARKET}/symbols/${SYMBOL}/quote`,
        { headers: session.headers },
      );
      const body = await readJson(response);
      if (!response.ok) throw failResponse('quote', response, body);
      return Array.isArray(body.asks) && body.asks.length > 0
        ? true
        : undefined;
    },
  );
}

async function placeMarketBuy(origin, session) {
  const response = await fetch(`${origin}/api/v1/orders`, {
    method: 'POST',
    headers: { ...session.headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      market: MARKET,
      symbol: SYMBOL,
      side: 'BUY',
      type: 'MARKET',
      quantity: QUANTITY,
    }),
  });
  const body = await readJson(response);
  if (response.status !== 201)
    throw failResponse('place MARKET BUY', response, body);
  if (typeof body.id !== 'string')
    throw new Error('place MARKET BUY: response carries no order id');
  return body.id;
}

async function waitForFill(origin, session, orderId) {
  return await pollUntil('order FILLED', FILL_TIMEOUT_MS, async () => {
    const response = await fetch(`${origin}/api/v1/orders/${orderId}`, {
      headers: session.headers,
    });
    const body = await readJson(response);
    if (!response.ok) throw failResponse('read order', response, body);
    if (body.status === 'FILLED') return body;
    if (TERMINAL_STATUSES.has(body.status))
      throw new Error(
        `order ${orderId} ended ${body.status} instead of FILLED (${JSON.stringify(body).slice(0, 500)})`,
      );
    return undefined;
  });
}

async function runScenario({
  loadConfig,
  ProductionRuntime,
  createFakeProviderBundle,
}) {
  const config = loadConfig();
  if (config.marketDataAdapter !== 'fake')
    throw new Error('the schema-compat runner only runs with the fake adapter');
  const bundle = createFakeProviderBundle();
  const runtime = new ProductionRuntime({ config, bundle, signals: false });
  let failure;
  try {
    await runtime.start();
    const origin = `http://127.0.0.1:${runtime.port}`;
    const session = await openAnonymousSession(origin, config.publicOrigin);
    emitOrderBook(bundle);
    await waitForOrderBook(origin, session);
    const orderId = await placeMarketBuy(origin, session);
    const order = await waitForFill(origin, session, orderId);
    if (order.filledQuantity !== QUANTITY)
      throw new Error(
        `order ${orderId} FILLED with quantity ${order.filledQuantity}, expected ${QUANTITY}`,
      );
    console.log(SUCCESS_MARKER);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await runtime.stop();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function main() {
  const watchdog = setTimeout(() => {
    console.error(`${FAILURE_MARKER}: runner exceeded ${RUNNER_BUDGET_MS} ms`);
    process.exit(2);
  }, RUNNER_BUDGET_MS);
  watchdog.unref();
  try {
    await runScenario(await importPreviousRelease());
  } catch (error) {
    console.error(
      `${FAILURE_MARKER}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
  }
}

await main();
// The runtime's pools and timers must not decide when a one-shot container
// ends: the exit code above is the verdict, so exit on it explicitly.
process.exit(process.exitCode ?? 0);
