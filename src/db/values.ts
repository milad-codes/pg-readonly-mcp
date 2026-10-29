/** Converts driver values to JSON-friendly ones: dates as ISO strings, binary as truncated hex. */
export function toJsonValue(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, 32).toString('hex');
    return `\\x${hex}${value.length > 32 ? `… (${value.length} bytes)` : ''}`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  return value;
}
