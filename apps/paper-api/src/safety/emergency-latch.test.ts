import { describe, expect, it } from 'vitest';
import { EmergencyLatch } from './emergency-latch.js';

describe('EmergencyLatch', () => {
  it('starts closed and admits only after explicitly opened', () => {
    const latch = new EmergencyLatch();
    expect(latch.admissionOpen).toBe(false);
    expect(latch.matchingOpen).toBe(false);
    latch.openAdmission();
    latch.openMatching();
    expect(latch.admissionOpen).toBe(true);
    expect(latch.matchingOpen).toBe(true);
    latch.closeAdmission();
    expect(latch.admissionOpen).toBe(false);
  });

  it('fails closed when a fatal error is reported', () => {
    const latch = new EmergencyLatch();
    latch.openAdmission();
    latch.openMatching();
    latch.closeOnFatal(new Error('audit unavailable'));
    expect(latch.admissionOpen).toBe(false);
    expect(latch.matchingOpen).toBe(false);
    expect(latch.lastFatal?.message).toBe('audit unavailable');
  });
});
