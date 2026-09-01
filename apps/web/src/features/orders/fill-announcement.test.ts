import { describe, expect, it } from 'vitest';
import {
  announceFill,
  createFillLedger,
  fillToastMessage,
  recordFills,
} from './fill-announcement';

/** The shape `#enrichPayload` puts on the wire: the event's own fields, then
 *  the whole portfolio snapshot on top. `activeOrders` is every order the
 *  session has, each with its complete fill history. */
const enriched = (
  event: Readonly<Record<string, unknown>>,
  orders: readonly Record<string, unknown>[],
) => ({
  ...event,
  wallets: [],
  positions: [],
  reservations: [],
  activeOrders: orders,
  accountSequence: '7',
  market: { health: {}, recoveryFill: {} },
  sessionId: 's',
});

const order = (
  overrides: Readonly<Record<string, unknown>> = {},
  fills: readonly Record<string, unknown>[] = [],
) => ({
  id: 'o1',
  market: 'US',
  symbol: 'AAPL',
  type: 'MARKET',
  side: 'BUY',
  quantity: '3',
  filledQuantity: '3',
  status: 'FILLED',
  limitPrice: null,
  stopPrice: null,
  terminalReason: null,
  fills,
  siblingOrderIds: [],
  ...overrides,
});

const fill = (
  id: string,
  quantity: string,
  price: string,
  currency = 'USD',
) => ({
  id,
  fillSequence: '1',
  accountSequence: '7',
  orderId: 'o1',
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  quantity,
  price,
  fee: '0',
  currency,
  isRecoveryFill: false,
  occurredAt: '2026-09-01T00:00:00.000Z',
});

const seeded = () => recordFills(createFillLedger(), enriched({}, []));

describe('announceFill', () => {
  it('announces a single new fill with its own quantity and price', () => {
    const { announcement } = announceFill(
      seeded(),
      'ORDER_FILLED',
      enriched({ orderId: 'o1', status: 'FILLED', filledQuantity: '3' }, [
        order({}, [fill('f1', '3', '325.26')]),
      ]),
    );
    expect(announcement).toEqual({
      id: 'f1',
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '3',
      price: '325.26',
      currency: 'USD',
      filledQuantity: '3',
      orderQuantity: '3',
      complete: true,
    });
  });

  it('reports a partial fill as progress against the order quantity', () => {
    const { announcement } = announceFill(
      seeded(),
      'ORDER_FILLED',
      enriched(
        { orderId: 'o1', status: 'PARTIALLY_FILLED', filledQuantity: '2' },
        [
          order(
            {
              side: 'SELL',
              symbol: '005930',
              market: 'KR',
              status: 'PARTIALLY_FILLED',
              filledQuantity: '2',
            },
            [fill('f1', '2', '70000', 'KRW')],
          ),
        ],
      ),
    );
    expect(announcement).toMatchObject({
      complete: false,
      side: 'SELL',
      symbol: '005930',
      quantity: '2',
      price: '70000',
      currency: 'KRW',
      filledQuantity: '2',
      orderQuantity: '3',
    });
  });

  it('drops the price when one delivery carried several new fills', () => {
    const { announcement } = announceFill(
      seeded(),
      'ORDER_FILLED',
      enriched({ orderId: 'o1', status: 'FILLED', filledQuantity: '3' }, [
        order({}, [fill('f1', '1', '325.26'), fill('f2', '2', '325.40')]),
      ]),
    );
    // The last new fill identifies the announcement; naming one of two prices
    // would be false and blending them would be arithmetic on money.
    expect(announcement).toEqual({
      id: 'f2',
      symbol: 'AAPL',
      side: 'BUY',
      filledQuantity: '3',
      orderQuantity: '3',
      complete: true,
    });
  });

  it('stays silent for a fill the snapshot already carried', () => {
    const ledger = recordFills(
      createFillLedger(),
      enriched({}, [order({}, [fill('f1', '3', '325.26')])]),
    );
    const { announcement } = announceFill(
      ledger,
      'ORDER_FILLED',
      enriched({ orderId: 'o1', status: 'FILLED', filledQuantity: '3' }, [
        order({}, [fill('f1', '3', '325.26')]),
      ]),
    );
    expect(announcement).toBeUndefined();
  });

  it('still announces a fill a refetched snapshot had already listed', () => {
    // `useOrderMutations` invalidates the portfolio the moment an order is
    // accepted, and a book with liquidity fills it before that refetch lands.
    // Were a mid-session snapshot treated as history, the fastest fills — the
    // ones the reader is least braced for — would be the ones never announced.
    const payload = enriched(
      { orderId: 'o1', status: 'FILLED', filledQuantity: '3' },
      [order({}, [fill('f1', '3', '325.26')])],
    );
    const refetched = recordFills(seeded(), payload);
    expect(
      announceFill(refetched, 'ORDER_FILLED', payload).announcement,
    ).toMatchObject({ id: 'f1' });
  });

  it('stays silent when the same delivery arrives twice', () => {
    const payload = enriched(
      { orderId: 'o1', status: 'FILLED', filledQuantity: '3' },
      [order({}, [fill('f1', '3', '325.26')])],
    );
    const first = announceFill(seeded(), 'ORDER_FILLED', payload);
    expect(first.announcement).toBeDefined();
    expect(
      announceFill(first.ledger, 'ORDER_FILLED', payload).announcement,
    ).toBeUndefined();
  });

  it('records replayed fills silently until a snapshot has been seen', () => {
    // The socket connects before `GET /api/v1/portfolio` resolves and the
    // server replays the whole outbox from sequence 0. None of it is news.
    const payload = enriched(
      { orderId: 'o1', status: 'FILLED', filledQuantity: '3' },
      [order({}, [fill('f1', '3', '325.26')])],
    );
    const replayed = announceFill(createFillLedger(), 'ORDER_FILLED', payload);
    expect(replayed.announcement).toBeUndefined();
    const afterSnapshot = recordFills(replayed.ledger, payload);
    expect(
      announceFill(afterSnapshot, 'ORDER_FILLED', payload).announcement,
    ).toBeUndefined();
  });

  it('announces a fill another event had already carried in its snapshot', () => {
    // Enrichment puts the whole portfolio on *every* event, and a book with
    // liquidity matches inside the placement itself — so `ORDER_PLACED` is
    // routinely enriched after the fill it precedes and lists it. Counting
    // that as delivery silences the fill's own event a moment later.
    const first = announceFill(
      seeded(),
      'ORDER_PLACED',
      enriched({ orderId: 'o1' }, [order({}, [fill('f1', '3', '325.26')])]),
    );
    expect(first.announcement).toBeUndefined();
    expect(
      announceFill(
        first.ledger,
        'ORDER_FILLED',
        enriched({ orderId: 'o1', status: 'FILLED', filledQuantity: '3' }, [
          order({}, [fill('f1', '3', '325.26')]),
        ]),
      ).announcement,
    ).toMatchObject({ id: 'f1' });
  });

  it("does not let one order's fills silence another order's", () => {
    const fills = [order({}, [fill('f1', '3', '325.26')])];
    const other = announceFill(
      seeded(),
      'ORDER_FILLED',
      enriched({ orderId: 'o2', status: 'FILLED', filledQuantity: '1' }, [
        ...fills,
        order({ id: 'o2', quantity: '1', filledQuantity: '1' }, [
          fill('f9', '1', '325.00'),
        ]),
      ]),
    );
    expect(other.announcement).toMatchObject({ id: 'f9' });
    expect(
      announceFill(
        other.ledger,
        'ORDER_FILLED',
        enriched(
          { orderId: 'o1', status: 'FILLED', filledQuantity: '3' },
          fills,
        ),
      ).announcement,
    ).toMatchObject({ id: 'f1' });
  });

  it.each([
    ['no payload at all', undefined],
    ['a payload that is not an object', 'nope'],
    ['an order the payload does not name', enriched({ status: 'FILLED' }, [])],
    [
      'a fill row without an id',
      enriched({ orderId: 'o1', status: 'FILLED', filledQuantity: '3' }, [
        order({}, [{ quantity: '3', price: '325.26' }]),
      ]),
    ],
    [
      'a side the contract does not define',
      enriched({ orderId: 'o1', status: 'FILLED', filledQuantity: '3' }, [
        order({ side: 'SHORT' }, [fill('f1', '3', '325.26')]),
      ]),
    ],
  ])('never throws and never announces on %s', (_name, payload) => {
    expect(() => announceFill(seeded(), 'ORDER_FILLED', payload)).not.toThrow();
    expect(announceFill(seeded(), 'ORDER_FILLED', payload).announcement).toBe(
      undefined,
    );
  });
});

describe('fillToastMessage', () => {
  const base = {
    id: 'f1',
    symbol: 'AAPL',
    side: 'BUY',
    filledQuantity: '3',
    orderQuantity: '3',
  } as const;

  it('words a complete fill with its price, grouped and in its currency', () => {
    expect(
      fillToastMessage({
        ...base,
        symbol: '005930',
        side: 'SELL',
        quantity: '3',
        price: '70000',
        currency: 'KRW',
        complete: true,
      }),
    ).toEqual({
      key: 'fillToast.complete',
      sideKey: 'ticket.sell',
      values: { symbol: '005930', quantity: '3', price: '₩70,000' },
    });
  });

  it('leaves the amount bare when the fill states no currency it knows', () => {
    // The rule `lib/currency.ts` already follows: a symbol this client guessed
    // is worse than a bare number.
    expect(
      fillToastMessage({
        ...base,
        quantity: '3',
        price: '325.26',
        currency: 'GBP',
        complete: true,
      }).values.price,
    ).toBe('325.26');
    expect(
      fillToastMessage({
        ...base,
        quantity: '3',
        price: '325.26',
        complete: true,
      }).values.price,
    ).toBe('325.26');
  });

  it('words a partial fill with the progress against the order', () => {
    expect(
      fillToastMessage({
        ...base,
        filledQuantity: '2',
        quantity: '2',
        price: '325.26',
        currency: 'USD',
        complete: false,
      }),
    ).toEqual({
      key: 'fillToast.partial',
      sideKey: 'ticket.buy',
      values: {
        symbol: 'AAPL',
        quantity: '2',
        price: '$325.26',
        filled: '2',
        total: '3',
      },
    });
  });

  it('falls back to the cumulative wording when no single price applies', () => {
    expect(fillToastMessage({ ...base, complete: true })).toEqual({
      key: 'fillToast.completeCumulative',
      sideKey: 'ticket.buy',
      values: { symbol: 'AAPL', total: '3' },
    });
    expect(
      fillToastMessage({ ...base, filledQuantity: '2', complete: false }),
    ).toEqual({
      key: 'fillToast.partialCumulative',
      sideKey: 'ticket.buy',
      values: { symbol: 'AAPL', filled: '2', total: '3' },
    });
  });
});
