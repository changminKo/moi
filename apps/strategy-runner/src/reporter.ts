import { redact } from './transport/redact.js';

/**
 * Where the runner says what it did. Design §3 names a `Reporter` that posts to
 * Discord; that webhook is phase D, so what B needs is the *seam* plus one
 * implementation that writes lines, and every masking obligation §7.4 states
 * discharged here rather than in the Discord client that will sit beside it.
 *
 * Redaction is applied by the reporter itself, unconditionally, to the message
 * and to every field value. A masker that only runs where someone remembered to
 * call it is not a masker.
 */

export type ReportLevel = 'info' | 'warn' | 'error';

export type ReportFields = Readonly<Record<string, string | number | boolean>>;

export interface Reporter {
  report(level: ReportLevel, message: string, fields?: ReportFields): void;
}

export interface ReportLine {
  readonly level: ReportLevel;
  readonly message: string;
  readonly fields: ReportFields;
}

/** Formats one line and masks it. Shared so a Discord embed masks identically. */
export function formatReport(line: ReportLine): string {
  const fields = Object.entries(line.fields)
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(' ');

  return redact(
    `[${line.level}] ${line.message}${fields.length === 0 ? '' : ` ${fields}`}`,
  );
}

export function createLineReporter(
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Reporter {
  return {
    report: (level, message, fields = {}) => {
      write(formatReport({ level, message, fields }));
    },
  };
}

/** Collects reports for a test to assert on. Masked exactly as the real one. */
export function createRecordingReporter(): Reporter & {
  readonly lines: readonly string[];
} {
  const lines: string[] = [];

  return {
    lines,
    report: (level, message, fields = {}) => {
      lines.push(formatReport({ level, message, fields }));
    },
  };
}
