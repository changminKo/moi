import { DomainError } from '@skipjack/trading-core';

export interface MarketEnvelope<T> {
  readonly recoveryEpoch: bigint;
  readonly leaderFencingToken: bigint;
  readonly marketDataVersion: bigint;
  readonly payload: T;
}

export interface MarketStateEvent<T> {
  readonly symbol: string;
  readonly version?: bigint;
  readonly marketDataVersion?: bigint;
  readonly payload: T;
  readonly recoveryEpoch?: bigint;
  readonly leaderFencingToken?: bigint;
}

export interface MarketStateStoreOptions {
  readonly recoveryEpoch?: bigint;
  readonly leaderFencingToken?: bigint;
}

export class MarketStateStore<T = unknown> {
  #epoch: bigint;
  #token: bigint;
  #version = 0n;
  readonly #symbols = new Map<string, { version: bigint; payload: T }>();

  constructor(options: MarketStateStoreOptions = {}) {
    this.#epoch = options.recoveryEpoch ?? 0n;
    this.#token = options.leaderFencingToken ?? 0n;
  }

  get recoveryEpoch(): bigint {
    return this.#epoch;
  }
  get leaderFencingToken(): bigint {
    return this.#token;
  }
  get currentVersion(): bigint {
    return this.#version;
  }

  beginEpoch(
    epoch?:
      | bigint
      | { readonly recoveryEpoch: bigint; readonly leaderFencingToken: bigint },
    token?: bigint,
  ): { recoveryEpoch: bigint; leaderFencingToken: bigint } {
    if (typeof epoch === 'object') {
      this.#epoch = epoch.recoveryEpoch;
      this.#token = epoch.leaderFencingToken;
    } else {
      this.#epoch = epoch ?? this.#epoch + 1n;
      if (token !== undefined) this.#token = token;
    }
    this.#version = 0n;
    this.#symbols.clear();
    return { recoveryEpoch: this.#epoch, leaderFencingToken: this.#token };
  }

  applyEvent(event: MarketStateEvent<T>): MarketEnvelope<T> {
    this.#assertOwner(event.recoveryEpoch, event.leaderFencingToken);
    const sequence = event.version ?? event.marketDataVersion;
    if (sequence === undefined)
      throw new DomainError(
        'INVARIANT_VIOLATION',
        'market event has no symbol version',
      );
    const previous = this.#symbols.get(event.symbol);
    if (previous !== undefined && sequence <= previous.version) {
      throw new DomainError(
        'ORDER_STATE_CONFLICT',
        `out-of-order market event for ${event.symbol}`,
      );
    }
    this.#version += 1n;
    this.#symbols.set(event.symbol, {
      version: sequence,
      payload: event.payload,
    });
    return this.envelope(event.payload);
  }

  replaceBaseline(
    symbol: string,
    payload: T,
    epoch = this.#epoch,
    token = this.#token,
  ): MarketEnvelope<T> {
    this.#assertOwner(epoch, token);
    this.#version += 1n;
    this.#symbols.set(symbol, { version: this.#version, payload });
    return this.envelope(payload);
  }

  get(symbol: string): T | undefined {
    return this.#symbols.get(symbol)?.payload;
  }

  private envelope(payload: T): MarketEnvelope<T> {
    return {
      recoveryEpoch: this.#epoch,
      leaderFencingToken: this.#token,
      marketDataVersion: this.#version,
      payload,
    };
  }

  #assertOwner(epoch?: bigint, token?: bigint): void {
    if (
      (epoch ?? this.#epoch) !== this.#epoch ||
      (token ?? this.#token) !== this.#token
    ) {
      throw new DomainError(
        'ORDER_STATE_CONFLICT',
        'stale market epoch or fencing token',
      );
    }
  }
}
