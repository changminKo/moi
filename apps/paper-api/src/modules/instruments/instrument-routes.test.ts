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
});
