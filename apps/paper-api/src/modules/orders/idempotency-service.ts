import { DomainError } from '@skipjack/trading-core';
export interface StoredHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export interface IdempotencyStore {
  begin(
    sessionId: string,
    key: string,
    hash: string,
  ): Promise<'STARTED' | 'IN_PROGRESS' | { response: StoredHttpResponse }>;
  complete(
    sessionId: string,
    key: string,
    hash: string,
    response: StoredHttpResponse,
  ): Promise<void>;
}
export class IdempotencyService {
  readonly #entries = new Map<
    string,
    {
      hash: string;
      response?: StoredHttpResponse;
      pending: Promise<StoredHttpResponse>;
    }
  >();
  constructor(private readonly store?: IdempotencyStore) {}
  async execute(
    sessionId: string,
    key: string,
    hash: string,
    work: () => Promise<StoredHttpResponse>,
  ): Promise<StoredHttpResponse> {
    if (this.store) {
      const state = await this.store.begin(sessionId, key, hash);
      if (state === 'IN_PROGRESS')
        return {
          statusCode: 409,
          headers: {},
          body: JSON.stringify({ code: 'IDEMPOTENCY_IN_PROGRESS' }),
        };
      if (typeof state === 'object') return state.response;
      const response = await work();
      if (response.statusCode !== 429 && response.statusCode !== 503)
        await this.store.complete(sessionId, key, hash, response);
      return response;
    }
    const id = `${sessionId}:${key}`;
    const existing = this.#entries.get(id);
    if (existing) {
      if (existing.hash !== hash)
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used for a different request',
        );
      if (existing.response) return existing.response;
      return existing.pending;
    }
    const pending = work();
    this.#entries.set(id, { hash, pending });
    const response = await pending;
    this.#entries.set(id, { hash, response, pending });
    return response;
  }
}
