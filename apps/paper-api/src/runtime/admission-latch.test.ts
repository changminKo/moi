import { describe, expect, it } from 'vitest';
import { AdmissionLatch } from './admission-latch.js';

describe('AdmissionLatch', () => {
  it('starts closed (fail-closed) and toggles', () => {
    const latch = new AdmissionLatch();
    expect(latch.isClosed).toBe(true);
    latch.open();
    expect(latch.isClosed).toBe(false);
    latch.close();
    expect(latch.isClosed).toBe(true);
  });
  it('is idempotent', () => {
    const latch = new AdmissionLatch();
    latch.open();
    latch.open();
    expect(latch.isClosed).toBe(false);
    latch.close();
    latch.close();
    expect(latch.isClosed).toBe(true);
  });
});
