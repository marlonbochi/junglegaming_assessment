/**
 * Deterministic JSON: keys sorted recursively, `undefined` object members omitted, no whitespace.
 * Throws for values with no canonical form (non-integer numbers, bigint, functions, symbols).
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isInteger(v)) throw new TypeError(`canonicalJson: non-integer number ${v}`);
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((i) => (i === undefined ? 'null' : canonicalJson(i))).join(',')}]`;
      const o = v as Record<string, unknown>;
      const members = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
  }
}
