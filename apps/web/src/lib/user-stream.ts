export type PortfolioEvent = Readonly<Record<string, unknown>>;
export type Market = 'KR' | 'US';
export type QuoteSnapshot = Readonly<Record<string, unknown>>;

export type UserStreamMessage =
  | {
      readonly type: 'ready';
      readonly accountSequence: string;
      readonly heartbeatIntervalMs: number;
    }
  | {
      readonly type: 'event';
      readonly eventId: string;
      readonly accountSequence: string;
      readonly eventType?: string;
      readonly payload: PortfolioEvent;
    }
  | {
      readonly type: 'quote';
      readonly market: Market;
      readonly symbol: string;
      readonly recoveryEpoch: string;
      readonly marketDataVersion: string;
      readonly payload: QuoteSnapshot;
    }
  | {
      readonly type: 'resync-required';
      readonly reason: 'BACKPRESSURE' | 'OUTBOX_GAP';
    }
  | { readonly type: 'heartbeat'; readonly serverTime: string };

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`invalid user stream ${name}`);
  return value;
}

export function parseUserStreamMessage(
  input: string | unknown,
): UserStreamMessage {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (!value || typeof value !== 'object' || !('type' in value))
    throw new Error('invalid user stream message');
  const message = value as Record<string, unknown>;
  const type = message.type;
  if (type === 'ready') {
    if (typeof message.heartbeatIntervalMs !== 'number')
      throw new Error('invalid heartbeat interval');
    return {
      type,
      accountSequence: stringField(message.accountSequence, 'accountSequence'),
      heartbeatIntervalMs: message.heartbeatIntervalMs,
    };
  }
  if (type === 'event') {
    if (!message.payload || typeof message.payload !== 'object')
      throw new Error('invalid event payload');
    return {
      type,
      eventId: stringField(message.eventId, 'eventId'),
      accountSequence: stringField(message.accountSequence, 'accountSequence'),
      ...(typeof message.eventType === 'string'
        ? { eventType: message.eventType }
        : {}),
      payload: message.payload as PortfolioEvent,
    };
  }
  if (type === 'quote') {
    if (
      (message.market !== 'KR' && message.market !== 'US') ||
      typeof message.symbol !== 'string' ||
      typeof message.payload !== 'object' ||
      !message.payload
    )
      throw new Error('invalid quote');
    return {
      type,
      market: message.market,
      symbol: message.symbol,
      recoveryEpoch: stringField(message.recoveryEpoch, 'recoveryEpoch'),
      marketDataVersion: stringField(
        message.marketDataVersion,
        'marketDataVersion',
      ),
      payload: message.payload as QuoteSnapshot,
    };
  }
  if (
    type === 'resync-required' &&
    (message.reason === 'BACKPRESSURE' || message.reason === 'OUTBOX_GAP')
  )
    return { type, reason: message.reason };
  if (type === 'heartbeat')
    return { type, serverTime: stringField(message.serverTime, 'serverTime') };
  throw new Error('unknown user stream message');
}
