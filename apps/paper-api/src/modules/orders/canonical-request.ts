import { createHash } from 'node:crypto';

const decimal = /^\d+(?:\.\d+)?$/;
function normalize(value: unknown, fields?: readonly string[]): unknown {
  if (typeof value === 'string' && decimal.test(value)) return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const order = fields ?? Object.keys(object).sort();
    return Object.fromEntries(order.filter((key) => key in object).map((key) => [key, normalize(object[key])]));
  }
  return value;
}
export function canonicalizeRequest(value: unknown, schemaFields?: readonly string[]): string {
  return JSON.stringify(normalize(value, schemaFields));
}
export function canonicalRequestHash(value: unknown, schemaFields?: readonly string[]): string {
  return createHash('sha256').update(Buffer.from(canonicalizeRequest(value, schemaFields), 'utf8')).digest('hex');
}
