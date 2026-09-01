// English message catalogue. `en` is the reference bundle: its keys define
// `MessageKey`, and the Korean catalogue must provide every one of them.
export const en = {
  'app.brandAria': 'Moi — go to trading',
  'app.navAria': 'Main menu',
  'app.navTrade': 'Trade',
  'app.navPortfolio': 'Portfolio',
  'app.localeSwitchAria': 'Language',

  'session.loading': 'Loading session…',
  'session.retry': 'Retry session',

  'banner.systemStatusAria': 'Trading system status',
  'common.retry': 'Retry',
  'common.dismiss': 'Dismiss',
  'common.close': 'Close',
  'common.cancel': 'Cancel',

  'instruments.title': 'Instrument search',
  'instruments.searchLabel': 'Search',
  'instruments.searchPlaceholder': 'Search symbols',
  'instruments.nonTradable': 'non-tradable',
  'instruments.showAll': 'Show all',

  'quote.empty': 'Select an instrument to see its quote.',
  'quote.timestamp': 'Timestamp',
  'quote.bookTitle': 'Order book depth',
  'quote.bookTitleWithCurrency': 'Order book depth · {{currency}}',
  'quote.asks': 'Asks',
  'quote.bids': 'Bids',
  'quote.ask': 'ask',
  'quote.bid': 'bid',
  'quote.noAsks': 'No asks',
  'quote.noBids': 'No bids',
  'quote.sparklineCollecting': 'Collecting chart data…',
  'quote.sparklineSummary': 'Last {{count}} ticks, high {{high}}, low {{low}}',
  'quote.sparklineSummaryPartial':
    '{{count}} of {{window}} ticks so far, high {{high}}, low {{low}}',
  'quote.chartWindow': 'Chart window',
  'quote.chartWindowOption': '{{count}} ticks',

  'ticket.title': 'Order ticket',
  'ticket.side': 'Side',
  'ticket.buy': 'Buy',
  'ticket.sell': 'Sell',
  'ticket.orderType': 'Order type',
  'ticket.type': 'Type',
  'ticket.typeMarket': 'Market',
  'ticket.typeLimit': 'Limit',
  'ticket.typeStop': 'Stop',
  'ticket.typeTakeProfit': 'Take profit',
  'ticket.typeOco': 'OCO',
  'ticket.quantity': 'Quantity',
  'ticket.price': 'Price',
  'ticket.triggerPrice': 'Trigger price',
  'ticket.stopPrice': 'Stop price',
  'ticket.estimate': 'Estimated ≈ {{amount}}',
  'ticket.estimateRange': 'Estimated ≈ {{low}} – {{high}}',
  'ticket.estimateUnavailable': 'Estimated — no price available',
  'ticket.place': 'Place order',
  'ticket.placeAria': 'Order ticket — Place order',
  'ticket.invalidOrder': 'Invalid order',
  'ticket.rejected': 'Order rejected',
  'ticket.placedOpen':
    'Order accepted — fills appear in your portfolio as they happen',
  'ticket.placedPendingTrigger':
    'Order accepted — it waits for its trigger price',
  'ticket.rejectedWithCode': 'Order rejected (code: {{code}})',
  'ticket.requestId': 'Request ID: {{requestId}}',

  'validation.quantity': 'Quantity must be a positive whole number',
  'validation.limitPrice': 'Limit price is required',
  'validation.stopPrice': 'Stop price is required',
  'validation.triggerPrice': 'Trigger price is required',
  'validation.takeProfitPrice': 'Take-profit price is required',
  'validation.ocoTriggersDiffer': 'OCO triggers must differ',

  // Public error codes from `POST /api/v1/orders` (docs/api/error-contract.md).
  // Their own catalogue, not the `reason.*` codes below: a reason says why
  // trading is degraded, these say why one order was refused.
  'orderError.SYMBOL_NOT_TRADABLE': 'This instrument cannot be traded',
  'orderError.MARKET_CLOSED': 'The market is closed',
  'orderError.MARKET_DATA_DEGRADED':
    'Market data is delayed — orders are paused',
  'orderError.RECOVERY_IN_PROGRESS':
    'Market data is recovering — try again shortly',
  'orderError.CANCEL_ONLY': 'Safety mode: only cancellations are accepted',
  'orderError.ACCOUNT_READ_ONLY': 'This account is locked for safety',
  'orderError.SERVICE_UNAVAILABLE':
    'The service is unavailable — try again shortly',
  'orderError.INSUFFICIENT_AVAILABLE_CASH':
    'Not enough available cash for this order',
  'orderError.INSUFFICIENT_AVAILABLE_POSITION':
    'Not enough available quantity to sell',
  'orderError.PRICE_PROTECTION':
    'Rejected by price protection — the price moved too far',
  'orderError.IDEMPOTENCY_CONFLICT':
    'This request conflicts with one already sent',
  'orderError.RATE_LIMITED': 'Too many requests — try again in a moment',
  'orderError.CAPACITY_REACHED': 'Too many open orders — cancel one first',
  'orderError.INVALID_QUANTITY': 'That quantity is not valid',
  'orderError.INVALID_PRICE': 'That price is not valid',
  'orderError.INVALID_ORDER': 'That order is not valid',
  'orderError.VALIDATION_ERROR': 'The order was not accepted as entered',
  'orderError.SESSION_EXPIRED': 'Your session expired — start a new one',
  'orderError.FORBIDDEN': 'This action is not allowed',
  'orderError.PAYLOAD_TOO_LARGE': 'The request was too large',
  'orderError.INVARIANT_VIOLATION':
    'The order could not be processed — nothing was placed',
  'orderError.INTERNAL_ERROR': 'Something went wrong — nothing was placed',

  'wallet.title': 'Wallets',
  'wallet.available': 'available',
  'wallet.reserved': 'reserved',
  'wallet.total': 'total',

  'fx.title': 'Virtual FX',
  'fx.amount': 'Amount',
  'fx.getQuote': 'Get quote',
  'fx.convert': 'Convert',
  'fx.rate': 'Exchange rate',
  'fx.rateValue': '1 {{to}} ≈ {{krw}} {{from}}',
  'fx.fee': 'Fee',
  'fx.source': 'You send',
  'fx.destination': 'You receive',
  'fx.amountPositive': 'Amount must be positive',
  'fx.quoteExpired': 'Quote expired. Refresh explicitly.',
  'fx.insufficient': 'Insufficient available balance',
  'fx.failed': 'Conversion failed',

  'portfolio.loading': 'Loading portfolio…',
  'portfolio.title': 'Portfolio',
  'portfolio.eyebrow': 'ACCOUNT / 02',
  'positions.title': 'Positions',
  'positions.empty': 'No positions yet.',
  'positions.caption':
    'Available and reserved position quantities with average cost',
  'positions.symbol': 'Symbol',
  'positions.available': 'Available',
  'positions.reserved': 'Reserved',
  'positions.total': 'Total',
  'positions.avgCost': 'Avg cost',

  'orders.title': 'Open orders',
  'orders.empty': 'No open orders.',
  'orders.filled': 'Filled',
  'orders.remaining': 'Remaining',
  'orders.ocoSibling': 'OCO sibling',
  'orders.cancelFailed': 'Cancellation failed',

  'fills.title': 'Fill history',
  'fills.empty': 'No fills yet.',
  'fills.fee': 'fee',
  'fills.recovery': 'Recovery fill',

  'amend.title': 'Amend order',
  'amend.save': 'Save changes',
  'amend.unavailable': 'Amendment unavailable.',

  // Trading reason codes. Both catalogues are typed against the same key
  // set, so a code translated in one language and not the other is a
  // compile error rather than a blank panel at runtime.
  'reason.MARKET_DATA_DEGRADED': 'Market data delayed',
  'reason.RECOVERY_IN_PROGRESS': 'Recovery in progress',
  'reason.CANCEL_ONLY': 'Safety mode: cancellations only',
  'reason.ACCOUNT_READ_ONLY': 'Account safety lock',
  'reason.UNAVAILABLE': 'Service unavailable',
  'reason.SERVICE_UNAVAILABLE': 'Service unavailable',
  'reason.SESSION_EXPIRED': 'Session expired — start a new session',
  'reason.SYMBOL_NOT_TRADABLE': 'This instrument is not tradable',

  'guard.unavailable': 'Action unavailable',
} as const;

export type MessageKey = keyof typeof en;
