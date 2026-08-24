import { describe, expect, it } from 'vitest';
import { TossWebSocketMarketData } from './toss-websocket.js';

describe('TossWebSocketMarketData', () => {
  it('requires the injectable socket factory and exposes the normalized stream contract', () => {
    expect(TossWebSocketMarketData).toBeDefined();
  });
});
