import { describe, expect, it } from 'vitest';
import { createSessionTokenCodec } from './session-token.js';

describe('session token codec', () => {
  it('issues 256 random bits and stores only a keyed digest', () => {
    const codec = createSessionTokenCodec(['active'], () =>
      Buffer.alloc(32, 7),
    );
    const issued = codec.issue();
    expect(issued.token).toHaveLength(43);
    expect(issued.tokenHash).not.toContain(issued.token);
    expect(codec.matches(issued.token, issued.tokenHash)).toBe(true);
  });
  it('accepts old key during rotation but not an unrelated hash', () => {
    const old = createSessionTokenCodec(['old']);
    const issued = old.issue();
    const rotated = createSessionTokenCodec(['new', 'old']);
    expect(rotated.matches(issued.token, issued.tokenHash)).toBe(true);
    expect(rotated.matches('wrong', issued.tokenHash)).toBe(false);
  });
});
