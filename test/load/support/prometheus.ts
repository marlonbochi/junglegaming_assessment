/** Minimal Prometheus text-format reader for the before/after `/metrics` scrapes of the load runs. */

export interface Series {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parsePrometheus(text: string): Series[] {
  const series: Series[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const [, k, v] of (m[2] ?? '').matchAll(LABEL)) if (k !== undefined && v !== undefined) labels[k] = v;
    series.push({ name: m[1] ?? '', labels, value: Number(m[3]) });
  }
  return series;
}

const keyOf = (s: Pick<Series, 'name' | 'labels'>) =>
  `${s.name}{${Object.keys(s.labels)
    .sort()
    .map((k) => `${k}=${s.labels[k]}`)
    .join(',')}}`;

/** Sums identical series across processes (several consumers expose the same names). */
export function merge(...scrapes: Series[][]): Series[] {
  const byKey = new Map<string, Series>();
  for (const s of scrapes.flat()) {
    const key = keyOf(s);
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, value: prev.value + s.value } : { ...s });
  }
  return [...byKey.values()];
}

/** after − before per series (counters and histograms; a series absent before counts from 0). */
export function delta(after: Series[], before: Series[]): Series[] {
  const prev = new Map(before.map((s) => [keyOf(s), s.value]));
  return after.map((s) => ({ ...s, value: s.value - (prev.get(keyOf(s)) ?? 0) }));
}

const matches = (s: Series, filter: Record<string, string>) => Object.entries(filter).every(([k, v]) => s.labels[k] === v);

export function total(series: Series[], name: string, filter: Record<string, string> = {}): number {
  return series.filter((s) => s.name === name && matches(s, filter)).reduce((sum, s) => sum + s.value, 0);
}

export function byLabel(series: Series[], name: string, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of series) {
    if (s.name !== name) continue;
    const key = s.labels[label] ?? '';
    out[key] = (out[key] ?? 0) + s.value;
  }
  return out;
}

/** Prometheus-style `histogram_quantile` (linear inside the bucket) over `<name>_bucket`. */
export function histogramQuantile(series: Series[], name: string, q: number, filter: Record<string, string> = {}): number | undefined {
  const buckets = new Map<number, number>();
  for (const s of series) {
    if (s.name !== `${name}_bucket` || !matches(s, filter)) continue;
    const le = s.labels.le === '+Inf' ? Infinity : Number(s.labels.le);
    buckets.set(le, (buckets.get(le) ?? 0) + s.value);
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const count = sorted.at(-1)?.[1] ?? 0;
  if (count <= 0) return undefined;
  const rank = q * count;
  let lower = 0;
  let below = 0;
  for (const [le, cumulative] of sorted) {
    if (cumulative >= rank) {
      if (le === Infinity) return lower;
      return lower + ((le - lower) * (rank - below)) / Math.max(cumulative - below, 1);
    }
    lower = le;
    below = cumulative;
  }
  return lower;
}
