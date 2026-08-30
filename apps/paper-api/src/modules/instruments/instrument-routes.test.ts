import { describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';

describe('instrument service', () => {
  it('searches all instruments but marks only the fixed universe tradable', async () => {
    const service = new InstrumentService({
      catalog: [
        { market: 'US', symbol: 'AAPL', name: 'Apple', tradable: true },
        {
          market: 'US',
          symbol: 'AAPL.UNLISTED',
          name: 'Apple legacy',
          tradable: false,
        },
      ],
    });
    const result = await service.search('apple');
    expect(result.items).toContainEqual(
      expect.objectContaining({ symbol: 'AAPL', tradable: true }),
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({ symbol: 'AAPL.UNLISTED', tradable: false }),
    );
  });

  it.each([
    ['삼성', ['005930']],
    ['삼서', ['005930']],
    ['ㅅㅅㅈㅈ', ['005930']],
    ['005930', ['005930']],
    ['apple', ['AAPL']],
    ['  ', ['005930', 'AAPL']],
    ['banana', []],
  ])(
    'matches %j against instrument names and symbols',
    async (query, symbols) => {
      const service = new InstrumentService({
        catalog: [
          {
            market: 'KR',
            symbol: '005930',
            name: '삼성전자',
            tradable: true,
          },
          {
            market: 'US',
            symbol: 'AAPL',
            name: 'Apple',
            tradable: true,
          },
        ],
      });

      const result = await service.search(query);

      expect(result.items.map((item) => item.symbol)).toEqual(symbols);
    },
  );

  it('atomically replaces the catalog after provider names load', async () => {
    const service = new InstrumentService({
      catalog: [
        {
          market: 'KR',
          symbol: '005930',
          name: '005930',
          tradable: true,
        },
      ],
    });

    service.replaceCatalog([
      {
        market: 'KR',
        symbol: '005930',
        name: '삼성전자',
        tradable: true,
      },
    ]);

    expect((await service.search('ㅅㅅㅈㅈ')).items).toEqual([
      expect.objectContaining({ symbol: '005930', name: '삼성전자' }),
    ]);
  });
});
