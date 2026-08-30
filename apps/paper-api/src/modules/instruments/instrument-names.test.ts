import {
  type InstrumentCatalog,
  TOSS_SYMBOL_WHITELIST,
} from '@moi/market-data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INSTRUMENT_NAMES_TIMEOUT_MS,
  instrumentSearchAliases,
  loadInstrumentNames,
} from './instrument-names.js';

const symbols = { KR: ['005930'], US: ['AAPL'] } as const;
const signal = new AbortController().signal;

function source(
  searchInstruments: InstrumentCatalog['searchInstruments'],
): Pick<InstrumentCatalog, 'searchInstruments'> {
  return { searchInstruments };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('loadInstrumentNames', () => {
  it('uses provider names for configured symbols and ignores other rows', async () => {
    const names = await loadInstrumentNames({
      source: source(async () => [
        {
          market: 'KR',
          symbol: '005930',
          name: '삼성전자 우선주',
          currency: 'KRW',
          tradable: true,
        },
        {
          market: 'US',
          symbol: 'AAPL',
          name: '애플',
          currency: 'USD',
          tradable: true,
        },
        {
          market: 'US',
          symbol: 'MSFT',
          name: '마이크로소프트',
          currency: 'USD',
          tradable: true,
        },
      ]),
      symbols,
      snapshot: [
        { market: 'KR', symbol: '005930', name: '삼성전자' },
        { market: 'US', symbol: 'AAPL', name: 'Apple snapshot' },
      ],
      signal,
      log: vi.fn(),
    });

    expect(names).toEqual(
      new Map([
        ['KR:005930', '삼성전자 우선주'],
        ['US:AAPL', '애플'],
      ]),
    );
  });

  it('falls back to the snapshot and logs only a sanitized error name', async () => {
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const names = await loadInstrumentNames({
      source: source(async () => {
        throw new Error('Bearer super-secret-token');
      }),
      symbols,
      snapshot: [
        { market: 'KR', symbol: '005930', name: '삼성전자' },
        { market: 'US', symbol: 'AAPL', name: '애플' },
      ],
      signal,
      log: (event, fields) => logs.push({ event, fields }),
    });

    expect(names).toEqual(
      new Map([
        ['KR:005930', '삼성전자'],
        ['US:AAPL', '애플'],
      ]),
    );
    expect(logs).toEqual([
      {
        event: 'instrument_names.provider_fallback',
        fields: { reason: 'Error' },
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('super-secret-token');
  });

  it('uses the symbol when neither provider nor snapshot has a name', async () => {
    const names = await loadInstrumentNames({
      source: source(async () => []),
      symbols,
      snapshot: [],
      signal,
      log: vi.fn(),
    });

    expect(names).toEqual(
      new Map([
        ['KR:005930', '005930'],
        ['US:AAPL', 'AAPL'],
      ]),
    );
  });

  it('aborts a stalled provider lookup and falls back after the timeout', async () => {
    vi.useFakeTimers();
    const names = loadInstrumentNames({
      source: source(
        async (_query, lookupSignal) =>
          await new Promise((_, reject) => {
            lookupSignal.addEventListener(
              'abort',
              () => reject(lookupSignal.reason),
              { once: true },
            );
          }),
      ),
      symbols,
      snapshot: [
        { market: 'KR', symbol: '005930', name: '삼성전자' },
        { market: 'US', symbol: 'AAPL', name: '애플' },
      ],
      signal,
      log: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(INSTRUMENT_NAMES_TIMEOUT_MS);

    expect(await names).toEqual(
      new Map([
        ['KR:005930', '삼성전자'],
        ['US:AAPL', '애플'],
      ]),
    );
  });

  it('propagates caller cancellation instead of treating shutdown as fallback', async () => {
    const controller = new AbortController();
    const log = vi.fn();
    const names = loadInstrumentNames({
      source: source(
        async (_query, lookupSignal) =>
          await new Promise((_, reject) => {
            lookupSignal.addEventListener(
              'abort',
              () => reject(lookupSignal.reason),
              { once: true },
            );
          }),
      ),
      symbols,
      snapshot: [],
      signal: controller.signal,
      log,
    });
    controller.abort(new DOMException('shutdown', 'AbortError'));

    await expect(names).rejects.toMatchObject({ name: 'AbortError' });
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps a non-symbol snapshot name for every production symbol', async () => {
    const names = await loadInstrumentNames({
      source: source(async () => []),
      symbols: { KR: ['005930'], US: TOSS_SYMBOL_WHITELIST },
      signal,
      log: vi.fn(),
    });

    expect(names.size).toBe(TOSS_SYMBOL_WHITELIST.length + 1);
    for (const [instrumentKey, name] of names) {
      expect(name).not.toBe(instrumentKey.split(':')[1]);
    }
    const aliases = instrumentSearchAliases({
      KR: ['005930'],
      US: TOSS_SYMBOL_WHITELIST,
    });
    expect(aliases.size).toBe(TOSS_SYMBOL_WHITELIST.length + 1);
    for (const searchNames of aliases.values()) {
      expect(searchNames.every((name) => name.trim().length > 0)).toBe(true);
    }
  });
});
