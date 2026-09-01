import { DomainError } from '@moi/trading-core';

import {
  assertCommandObject,
  isIdentifier,
  isPositiveWholeQuantity,
  MAX_IDENTIFIER_LENGTH,
} from './validation.js';

/**
 * The parameter layer of the strategy contract: a strategy publishes its
 * `parameterSchema` as a *value*, so the runner can validate every configured
 * strategy — and report what each one accepts — before any of them runs.
 *
 * This is deliberately not a schema library. `zod` is already in the repository
 * (`apps/paper-api`, `packages/market-data`), and it was rejected here for two
 * reasons. It would be this package's first runtime dependency beyond
 * trading-core, and therefore the bot container's, for a handful of scalar
 * fields. And the SDK already owns one validation posture — the single-read
 * boundary predicates in `validation.ts`, built so the value that is checked is
 * the value that is used — so a second, differently-behaved one inside the same
 * package costs more in confusion than it saves in code. Every predicate below
 * delegates to `validation.ts`, which means a strategy parameter and an order
 * field are held to one rule rather than two near-copies.
 *
 * Also rejected: JSON Schema with `ajv` (a dependency, and no static types
 * without a codegen step), and a plain `parseParams` function per strategy (the
 * runner needs to validate and describe a strategy's parameters without
 * instantiating it, which only a value can do).
 */

export interface ParameterFieldDescription {
  readonly name: string;
  readonly kind: string;
  readonly constraint: string;
}

/**
 * One parameter's rule. `read` performs no property access of its own — it is
 * handed the single value the schema already read — so a field cannot see a
 * different value than the one presence was decided on.
 */
export interface ParameterField<T> {
  readonly kind: string;
  readonly constraint: string;
  read(value: unknown, name: string): T;
}

// `unknown` rather than `never`: `read` returns `T`, so `ParameterField` is
// covariant in it and only the top type accepts every field.
type ParameterFields = Readonly<Record<string, ParameterField<unknown>>>;

type ParametersOf<F extends ParameterFields> = {
  readonly [K in keyof F]: F[K] extends ParameterField<infer T> ? T : never;
};

export interface ParameterSchema<P> {
  /** Declaration order, which is also the order `parse` reads and reports in. */
  readonly fieldNames: readonly string[];
  describe(): readonly ParameterFieldDescription[];
  /** Validates untrusted configuration into a frozen typed value. */
  parse(input: unknown): P;
}

const invalid = (message: string): never => {
  throw new DomainError('INVALID_ORDER', message);
};

/**
 * A count, not money: a period is how many ticks to average over, so it is a
 * JS integer rather than a decimal string. AGENTS.md rule 5 governs prices and
 * quantities — the values that reach the ledger's arithmetic — and `quantity`
 * below is exactly that, a plain decimal string.
 */
export function integerParameter(options: {
  readonly min: number;
  readonly max: number;
}): ParameterField<number> {
  const constraint = `a whole number from ${options.min} to ${options.max}`;

  return {
    kind: 'integer',
    constraint,
    read: (value, name) =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= options.min &&
      value <= options.max
        ? value
        : invalid(`${name} must be ${constraint}`),
  };
}

// `const` so `enumParameter(['KR', 'US'])` yields `ParameterField<'KR' | 'US'>`
// and the parsed value narrows to the domain union rather than to `string`.
export function enumParameter<const T extends string>(
  allowed: readonly [T, ...(readonly T[])],
): ParameterField<T> {
  const constraint = `one of ${allowed.join(', ')}`;

  return {
    kind: 'enum',
    constraint,
    // A list scan rather than a property lookup, so `toString` and `__proto__`
    // are non-members like any other unlisted string.
    read: (value, name) =>
      typeof value === 'string' && allowed.includes(value as T)
        ? (value as T)
        : invalid(`${name} must be ${constraint}`),
  };
}

/** A tradable symbol, held to the same rule as a symbol on an order. */
export function symbolParameter(): ParameterField<string> {
  const constraint = `a non-empty identifier of at most ${MAX_IDENTIFIER_LENGTH} printable characters`;

  return {
    kind: 'identifier',
    constraint,
    read: (value, name) =>
      isIdentifier(value) ? value : invalid(`${name} must be ${constraint}`),
  };
}

/** An order size, held to the same rule as a quantity on an order. */
export function quantityParameter(): ParameterField<string> {
  const constraint = 'a positive whole number in plain decimal form';

  return {
    kind: 'quantity',
    constraint,
    read: (value, name) => {
      if (!isPositiveWholeQuantity(value)) {
        throw new DomainError(
          'INVALID_QUANTITY',
          `${name} must be ${constraint}`,
        );
      }

      return value;
    },
  };
}

/**
 * Builds a schema from a field record, with an optional cross-field refinement
 * that runs once every field has been read.
 *
 * Presence here is **own-key** presence, unlike the prototype-inclusive policy
 * `readOptionalField` applies to an order command. The difference is in what
 * crosses the boundary: a command may legitimately be a class instance, a
 * builder result, or a proxy, and that is a shape this package's own published
 * interfaces bless. Strategy parameters are decoded JSON from a configuration
 * file, or an object literal — never an accessor-backed object — so own-key
 * presence costs nothing and closes the direction that matters: a polluted
 * `Object.prototype` cannot supply a risk parameter nobody wrote down.
 *
 * Unknown keys are refused rather than ignored, and every declared key is
 * required. There is no optional field and no default: nothing in phase A needs
 * one, and a risk parameter that quietly defaults is precisely the value an
 * operator should have to write down.
 */
export function defineParameterSchema<const F extends ParameterFields>(
  fields: F,
  refine?: (params: ParametersOf<F>) => void,
): ParameterSchema<ParametersOf<F>> {
  const fieldNames = Object.freeze(Object.keys(fields));
  const descriptions = Object.freeze(
    fieldNames.map((name) => {
      const field = fields[name] as ParameterField<unknown>;

      return Object.freeze({
        name,
        kind: field.kind,
        constraint: field.constraint,
      });
    }),
  );

  return {
    fieldNames,
    describe: () => descriptions,
    parse: (input) => {
      assertCommandObject(input, 'strategy parameters');

      const unknownKeys = Object.keys(input).filter(
        (key) => !Object.hasOwn(fields, key),
      );

      if (unknownKeys.length > 0) {
        invalid(`unknown strategy parameters: ${unknownKeys.join(', ')}`);
      }

      const parsed: Record<string, unknown> = {};

      for (const name of fieldNames) {
        if (!Object.hasOwn(input, name)) {
          invalid(`${name} is required`);
        }

        // One read per field, and the value read is the value validated and the
        // value returned.
        parsed[name] = (fields[name] as ParameterField<unknown>).read(
          input[name],
          name,
        );
      }

      const params = Object.freeze(parsed) as ParametersOf<F>;

      refine?.(params);

      return params;
    },
  };
}
