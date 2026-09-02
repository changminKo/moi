import { describe, expect, it } from 'vitest';
import { createLineReporter, createRecordingReporter } from './reporter.js';

describe('reporter', () => {
  it('writes the level, the message and the fields', () => {
    const lines: string[] = [];

    createLineReporter((line) => lines.push(line)).report(
      'warn',
      'session replaced',
      { previousSessionId: 's-1', sessionId: 's-2' },
    );

    expect(lines).toStrictEqual([
      '[warn] session replaced previousSessionId=s-1 sessionId=s-2',
    ]);
  });

  /**
   * §7.4: a cookie or a CSRF token must never reach a log or a Discord message.
   * The reporter masks unconditionally, so a caller that puts one in a field by
   * mistake cannot leak it.
   */
  it('masks a secret a caller passed in by mistake', () => {
    const reporter = createRecordingReporter();

    reporter.report('info', 'reusing moi_session=abc.def', {
      header: 'x-csrf-token: nonce.signature',
    });

    expect(reporter.lines).toStrictEqual([
      '[info] reusing moi_session=*** header=x-csrf-token: ***',
    ]);
  });

  it('writes a message with no fields', () => {
    const reporter = createRecordingReporter();

    reporter.report('error', 'quarantined');

    expect(reporter.lines).toStrictEqual(['[error] quarantined']);
  });
});
