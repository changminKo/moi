import { describe, expect, it } from 'vitest';
import { FxService } from './fx-service.js';

describe('virtual FX', () => {
  it('rejects an exchange quote after ten seconds', async () => {
    let now = 1_700_000_000_000;
    const fx = new FxService({ clock: () => new Date(now), rate: '0.0007' });
    const quote = await fx.quote('session-1', {
      from: 'KRW',
      to: 'USD',
      amount: '100000',
    });
    now += 10_001;
    await expect(
      fx.exchange('session-1', quote.id, 'key-1'),
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });
});
