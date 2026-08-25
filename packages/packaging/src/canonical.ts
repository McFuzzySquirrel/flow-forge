/**
 * Canonical JSON serialisation — a stable byte representation of a JSON value.
 * Keys are sorted recursively and no whitespace is emitted, so the same value
 * always serialises to the same bytes. This is what we hash and sign, which is
 * what makes signatures stable across runs and independent of key insertion
 * order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
