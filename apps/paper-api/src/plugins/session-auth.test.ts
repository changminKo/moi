import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { cookieValue, cookieValueFromHeader } from './session-auth.js';

describe('cookie parsing (U10)', () => {
  it('shares one parser between request and raw header', () => {
    const header = 'a=1; sid=x%3Dy; b=2';
    const request = {
      headers: { cookie: header },
    } as unknown as FastifyRequest;
    expect(cookieValueFromHeader(header, 'sid')).toBe('x=y');
    expect(cookieValue(request, 'sid')).toBe(
      cookieValueFromHeader(header, 'sid'),
    );
    expect(cookieValueFromHeader(header, 'b')).toBe('2');
    expect(cookieValueFromHeader(undefined, 'sid')).toBeUndefined();
    expect(cookieValueFromHeader('', 'sid')).toBeUndefined();
    expect(cookieValueFromHeader('sid=abc', 'si')).toBeUndefined();
  });
});
