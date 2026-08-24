const SECRET =
  /authorization|cookie|csrf|session.?token|oauth|client.?secret|password/i;
export function safeAuditLog(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input))
    result[key] = SECRET.test(key) ? '[REDACTED]' : value;
  return result;
}
