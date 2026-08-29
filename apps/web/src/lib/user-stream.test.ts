import { describe, expect, it } from 'vitest';
import { parseUserStreamMessage } from './user-stream';

describe('user stream protocol', () => {
  it('parses discriminated messages without coercing decimal strings', () => {
    const message = parseUserStreamMessage(
      JSON.stringify({
        type: 'event',
        eventId: 'evt-1',
        accountSequence: '9007199254740993',
        payload: {},
      }),
    );
    expect(message).toMatchObject({
      type: 'event',
      accountSequence: '9007199254740993',
    });
  });

  it('rejects unknown protocol messages', () => {
    expect(() => parseUserStreamMessage('{"type":"unknown"}')).toThrow();
  });
});
