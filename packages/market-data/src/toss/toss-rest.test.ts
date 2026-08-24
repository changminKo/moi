import { describe, expect, it } from 'vitest';
import { TossRestClient } from './toss-rest.js';

describe('TossRestClient', () => {
  it('is the REST implementation of the normalized ports', () => {
    expect(TossRestClient).toBeDefined();
  });
});
