/**
 * Zod schemas for the inbound Toss WebSocket frames, derived from the pinned
 * `contracts/toss/asyncapi.json` (advertised version 1.2.2) recorded in
 * `contracts/toss/provenance.json`.
 *
 * Two rules shape everything below.
 *
 * 1. **Enums stay opaque.** The contract documents `currency` as `KRW | USD`
 *    and then says, in the same field, that clients must tolerate unknown enum
 *    values. So no schema here is a Zod enum: a frame carrying a currency,
 *    rejection code, or error code this build has never heard of still parses,
 *    and the unknown value survives as a plain string. Narrowing an opaque
 *    string to a domain type is a separate, refusable step
 *    (`toMarketEvent` in `parse-frame.ts`), which is what turns an unknown
 *    value into an unsupported-data incident instead of a crashed process.
 *
 * 2. **Decimals are strings, never coerced.** A JSON number in a price field
 *    is a rejected frame, not a rounded one. `z.number()` is absent from this
 *    file on purpose, and so is every `coerce`.
 */
import { z } from 'zod';

/**
 * A plain base-10 literal, matching `readDecimalString` in `../types.ts`. The
 * contract caps these fields at 30 characters, so the length bound is the
 * contract's, not ours.
 */
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const DECIMAL_MAX_LENGTH = 30;

export const tossDecimalSchema = z
  .string()
  .max(DECIMAL_MAX_LENGTH)
  .regex(DECIMAL_PATTERN);

/**
 * `format: date-time` in the contract. Parsed with `Date.parse` rather than a
 * pattern because the provider sends offset-bearing stamps
 * (`2026-06-18T23:30:00.000+09:00`), not only `Z`.
 */
export const tossTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    error: 'must be an ISO 8601 date-time',
  });

/** Opaque by contract instruction — see rule 1 above. */
export const tossCurrencySchema = z.string().min(1);

export const tossTopicSchema = z.string().min(1);

const tossFrameTypeSchema = z.string().min(1);

export const tossOrderBookLevelSchema = z.object({
  price: tossDecimalSchema,
  volume: tossDecimalSchema,
});

export const tossTradeDataSchema = z.looseObject({
  price: tossDecimalSchema,
  volume: tossDecimalSchema,
  timestamp: tossTimestampSchema,
  currency: tossCurrencySchema,
});

export const tossOrderBookDataSchema = z.looseObject({
  // Optional *and* nullable: the contract omits `timestamp` from `required`
  // and types it `["string", "null"]`, so both shapes mean "no source time".
  timestamp: tossTimestampSchema.nullish(),
  currency: tossCurrencySchema,
  asks: z.array(tossOrderBookLevelSchema),
  bids: z.array(tossOrderBookLevelSchema),
});

export const tossTradeFrameSchema = z.object({
  type: z.literal('message'),
  topic: tossTopicSchema,
  data: tossTradeDataSchema,
});

export const tossOrderBookFrameSchema = z.object({
  type: z.literal('message'),
  topic: tossTopicSchema,
  data: tossOrderBookDataSchema,
});

export const tossSubscriptionRejectionSchema = z.object({
  target: z.string().min(1),
  code: z.string().min(1),
  message: z.string(),
});

export const tossSubscriptionAckFrameSchema = z.object({
  type: z.literal('subscriptions'),
  id: z.string().optional(),
  subscribed: z.array(z.string()),
  rejected: z.array(tossSubscriptionRejectionSchema),
});

export const tossErrorFrameSchema = z.object({
  type: z.literal('error'),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
  }),
  id: z.string().optional(),
});

export const tossPongFrameSchema = z.object({
  type: z.literal('pong'),
});

/**
 * The dispatch discriminator. The contract routes every inbound frame on the
 * top-level `type`, so this schema reads only that much: it decides *which*
 * frame schema applies, and the frame schema decides whether the frame is
 * valid.
 */
export const tossFrameEnvelopeSchema = z.looseObject({
  type: tossFrameTypeSchema,
});

/** The channel prefix of a data-frame topic (`trade:us:AAPL`). */
export const TOSS_DATA_CHANNELS = ['trade', 'orderbook'] as const;

export type TossDataChannel = (typeof TOSS_DATA_CHANNELS)[number];

export interface TossTopicParts {
  readonly channel: TossDataChannel;
  readonly providerMarket: string;
  readonly symbol: string;
}

/**
 * Splits `trade:us:AAPL` into its three parts. A topic naming an unknown
 * channel returns null rather than throwing, so the caller decides whether an
 * unroutable frame is a rejection or a skip. `personal:order:{accountSeq}` is
 * out of this package's scope and lands here as an unknown channel.
 */
export const parseTossTopic = (topic: string): TossTopicParts | null => {
  const parts = topic.split(':');
  if (parts.length !== 3) {
    return null;
  }

  const [channel, providerMarket, symbol] = parts;
  if (
    channel === undefined ||
    providerMarket === undefined ||
    symbol === undefined ||
    providerMarket.length === 0 ||
    symbol.length === 0
  ) {
    return null;
  }

  if (!isTossDataChannel(channel)) {
    return null;
  }

  return { channel, providerMarket, symbol };
};

const isTossDataChannel = (value: string): value is TossDataChannel =>
  (TOSS_DATA_CHANNELS as readonly string[]).includes(value);

export type TossTradeData = z.infer<typeof tossTradeDataSchema>;
export type TossOrderBookData = z.infer<typeof tossOrderBookDataSchema>;
export type TossOrderBookLevel = z.infer<typeof tossOrderBookLevelSchema>;
export type TossSubscriptionRejectionPayload = z.infer<
  typeof tossSubscriptionRejectionSchema
>;
