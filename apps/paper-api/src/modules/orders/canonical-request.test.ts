import { describe, expect, it } from 'vitest';
import {
  canonicalizeRequest,
  canonicalRequestHash,
} from './canonical-request.js';

describe('canonical order requests', () => {
  it('orders schema fields and normalizes decimals before hashing', () => {
    const a = {
      quantity: '1.0',
      side: 'BUY',
      limitPrice: '10.00',
      symbol: 'AAPL',
    };
    const b = { symbol: 'AAPL', limitPrice: '10', quantity: '1', side: 'BUY' };
    expect(
      canonicalizeRequest(a, ['symbol', 'side', 'quantity', 'limitPrice']),
    ).toBe('{"symbol":"AAPL","side":"BUY","quantity":"1","limitPrice":"10"}');
    expect(
      canonicalRequestHash(a, ['symbol', 'side', 'quantity', 'limitPrice']),
    ).toBe(
      canonicalRequestHash(b, ['symbol', 'side', 'quantity', 'limitPrice']),
    );
  });
});
