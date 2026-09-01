import { readFile } from 'node:fs/promises';
import { type APIRequestContext, test as base, expect } from '@playwright/test';
import { type E2eStateFile, stateFilePath } from '../state-file.js';

type BookInput = Readonly<{
  market: 'KR' | 'US';
  symbol: string;
  bids: readonly { price: string; volume: string }[];
  asks: readonly { price: string; volume: string }[];
}>;
type FillInput = Readonly<{
  orderId: string;
  quantity: string;
  price: string;
  duplicate?: boolean;
}>;

class PaperSystem {
  readonly #request: APIRequestContext;
  readonly #state: E2eStateFile;

  constructor(request: APIRequestContext, state: E2eStateFile) {
    this.#request = request;
    this.#state = state;
  }

  async #call<T>(
    path: string,
    options: { method?: 'GET' | 'POST'; data?: unknown } = {},
  ): Promise<T> {
    const response = await this.#request.fetch(
      new URL(path, this.#state.controlOrigin).toString(),
      {
        method: options.method ?? 'POST',
        headers: { authorization: `Bearer ${this.#state.credential}` },
        ...(options.data === undefined ? {} : { data: options.data }),
      },
    );
    expect(response.ok(), `${path} control request`).toBe(true);
    return (await response.json()) as T;
  }

  reset(): Promise<unknown> {
    return this.#call('/reset');
  }

  setBook(input: BookInput): Promise<unknown> {
    return this.#call('/book', { data: input });
  }

  setMode(mode: 'DEGRADED' | 'CANCEL_ONLY'): Promise<unknown> {
    return this.#call('/mode', { data: { mode } });
  }

  recover(): Promise<unknown> {
    return this.#call('/recover');
  }

  async latestOrderId(): Promise<string> {
    const result = await this.#call<{ id?: string }>('/latest-order', {
      method: 'GET',
    });
    if (!result.id) throw new Error('No order exists');
    return result.id;
  }

  async orderStatus(orderId: string): Promise<string | undefined> {
    const result = await this.#call<{ status?: string }>(
      `/order-status?id=${encodeURIComponent(orderId)}`,
      { method: 'GET' },
    );
    return result.status;
  }

  fill(input: FillInput): Promise<unknown> {
    return this.#call('/fill', { data: input });
  }

  triggerOco(input: { orderId: string; price: string }): Promise<unknown> {
    return this.#call('/trigger-oco', { data: input });
  }

  emitSequenceGap(
    input: { count?: number; resync?: boolean } = {},
  ): Promise<unknown> {
    return this.#call('/sequence-gap', { data: input });
  }

  snapshotBarrier(action: 'hold' | 'release'): Promise<unknown> {
    return this.#call('/snapshot-barrier', { data: { action } });
  }

  async snapshotStats(): Promise<{
    count: number;
    completed: number;
    inFlight: number;
    maxConcurrency: number;
  }> {
    return this.#call('/snapshot-count', {
      method: 'GET',
    });
  }

  async waitForStream(): Promise<void> {
    await expect
      .poll(async () => {
        const result = await this.#call<{ count: number }>('/stream-count', {
          method: 'GET',
        });
        return result.count;
      })
      .toBeGreaterThan(0);
  }
}

export const test = base.extend<{ paperSystem: PaperSystem }>({
  // The UI defaults to Korean; the journeys assert the English vocabulary, so
  // every context seeds the persisted locale before any document loads. The
  // init script re-runs on every navigation, so a spec that needs the real
  // default (locale-switch.spec.ts) builds its own context from `browser`.
  context: async ({ context }, use) => {
    await context.addInitScript(() => {
      window.localStorage.setItem('moi.locale', 'en');
    });
    await use(context);
  },
  paperSystem: async ({ request }, use) => {
    const state = JSON.parse(
      await readFile(stateFilePath, 'utf8'),
    ) as E2eStateFile;
    const system = new PaperSystem(request, state);
    await system.reset();
    await use(system);
  },
});

export { expect };
