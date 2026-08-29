const SECRET_KEY =
  /authorization|cookie|csrf|session.?token|oauth|client.?secret|password|access.?token|refresh.?token|TOSS_CLIENT_SECRET/i;
const BEARER_VALUE = /Bearer\s+\S+/g;

function redactValue(value: unknown): unknown {
  if (typeof value === 'string')
    return value.replace(BEARER_VALUE, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object')
    return safeAuditLog(value as Record<string, unknown>);
  return value;
}

/**
 * Redacts credential-bearing keys and Bearer tokens before anything reaches a
 * log or audit payload (§12.1). Correlation fields are preserved untouched.
 */
export function safeAuditLog(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input))
    result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(value);
  return result;
}
