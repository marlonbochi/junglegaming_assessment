import { byLabel, histogramQuantile, total, type Series } from './prometheus';
import type { ContainerStat, PgSample } from './samplers';

// ---------- k6 --summary-export ----------

export interface Latency {
  avg: number;
  med: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

type K6Metric = Record<string, number | Record<string, boolean>>;
export interface K6Export {
  metrics: Record<string, K6Metric>;
}

const num = (m: K6Metric | undefined, key: string): number => {
  const v = m?.[key];
  return typeof v === 'number' ? v : 0;
};

export function latencyOf(k6: K6Export, metric: string): Latency {
  const m = k6.metrics[metric];
  return {
    avg: num(m, 'avg'),
    med: num(m, 'med'),
    p90: num(m, 'p(90)'),
    p95: num(m, 'p(95)'),
    p99: num(m, 'p(99)'),
    max: num(m, 'max'),
  };
}

export const countOf = (k6: K6Export, metric: string) => num(k6.metrics[metric], 'count');
/** `value` of a Rate metric (e.g. the share of failed requests). */
export const rateOf = (k6: K6Export, metric: string) => num(k6.metrics[metric], 'value');

/** Thresholds k6 reports as crossed (`true` in the legacy export). */
export function failedThresholds(k6: K6Export): string[] {
  const failed: string[] = [];
  for (const [name, metric] of Object.entries(k6.metrics)) {
    const thresholds = metric.thresholds;
    if (typeof thresholds !== 'object') continue;
    for (const [expr, crossed] of Object.entries(thresholds)) if (crossed) failed.push(`${name} ${expr}`);
  }
  return failed;
}

export interface HttpSummary {
  requests: number;
  rps: number;
  latencyMs: Latency;
  errorRate: number;
  responses: { ok2xx: number; rejected422: number; unexpected4xx: number; server5xx: number; noStatus: number };
  correctness: { passes: number; fails: number };
  droppedIterations: number;
}

export function httpSummary(k6: K6Export): HttpSummary {
  const correctness = k6.metrics['checks{type:correctness}'];
  return {
    requests: countOf(k6, 'http_reqs'),
    rps: num(k6.metrics.http_reqs, 'rate'),
    latencyMs: latencyOf(k6, 'http_req_duration'),
    errorRate: rateOf(k6, 'http_req_failed'),
    responses: {
      ok2xx: countOf(k6, 'responses_2xx'),
      rejected422: countOf(k6, 'responses_422'),
      unexpected4xx: countOf(k6, 'responses_unexpected_4xx'),
      server5xx: countOf(k6, 'responses_5xx'),
      noStatus: countOf(k6, 'responses_no_status'),
    },
    correctness: { passes: num(correctness, 'passes'), fails: num(correctness, 'fails') },
    droppedIterations: countOf(k6, 'dropped_iterations'),
  };
}

/** One tagged slice of the run (a staircase level, a hot-wallet phase, a soak minute). */
export interface Slice {
  tag: string;
  requests: number;
  rps: number;
  latencyMs: Latency;
  errorRate: number;
}

export function sliceOf(k6: K6Export, tag: string, seconds: number): Slice {
  const requests = countOf(k6, `http_reqs{${tag}}`);
  return {
    tag,
    requests,
    rps: requests / seconds,
    latencyMs: latencyOf(k6, `http_req_duration{${tag}}`),
    errorRate: rateOf(k6, `http_req_failed{${tag}}`),
  };
}

export interface Capacity {
  sustainableRps: number;
  maxThroughputRps: number;
  saturatedAt: number | null;
}

/**
 * `maxThroughputRps`: the highest rate actually achieved on any held level (the saturation
 * throughput). `sustainableRps`: the highest level held with ≥ 97% of the target rate, < 1% errors and
 * p95 ≤ 100 ms (the latency-bounded capacity); `saturatedAt`: the first level that misses it.
 */
export function capacityOf(slices: Slice[] | undefined, levels: number[]): Capacity {
  let sustainableRps = 0;
  let saturatedAt: number | null = null;
  for (const [i, level] of levels.entries()) {
    const s = slices?.[i];
    if (!s) break;
    const ok = s.rps >= 0.97 * level && s.errorRate < 0.01 && s.latencyMs.p95 <= 100;
    if (ok && saturatedAt === null) sustainableRps = level;
    else if (!ok && saturatedAt === null) saturatedAt = level;
  }
  const maxThroughputRps = Math.max(0, ...(slices ?? []).map((s) => s.rps));
  return { sustainableRps, maxThroughputRps, saturatedAt };
}

// ---------- /metrics deltas ----------

export interface ServiceMetrics {
  lockConflicts: number;
  retries: Record<string, number>;
  dlq: Record<string, number>;
  duplicates: Record<string, number>;
  transactions: Record<string, number>;
  processingMs: Record<string, { mean?: number; p50?: number; p95?: number; p99?: number }>;
}

export function serviceMetrics(d: Series[]): ServiceMetrics {
  const processingMs: ServiceMetrics['processingMs'] = {};
  for (const source of ['http', 'sqs']) {
    const count = total(d, 'wagering_processing_duration_seconds_count', { source });
    if (count <= 0) continue;
    const ms = (q: number) => {
      const v = histogramQuantile(d, 'wagering_processing_duration_seconds', q, { source });
      return v === undefined ? undefined : v * 1000;
    };
    processingMs[source] = {
      mean: (total(d, 'wagering_processing_duration_seconds_sum', { source }) / count) * 1000,
      p50: ms(0.5),
      p95: ms(0.95),
      p99: ms(0.99),
    };
  }
  return {
    lockConflicts: total(d, 'db_lock_conflicts_total'),
    retries: byLabel(d, 'wagering_retries_total', 'component'),
    dlq: byLabel(d, 'sqs_dlq_messages_total', 'reason'),
    duplicates: byLabel(d, 'wagering_duplicates_total', 'type'),
    transactions: byLabel(d, 'wagering_transactions_total', 'status'),
    processingMs,
  };
}

// ---------- pg_stat_activity samples ----------

export interface PgAnalysis {
  samples: number;
  /** Share of sampled *active* backends per wait event ("CPU:-" = running, not waiting). */
  activeWaits: Array<{ event: string; share: number; avgBackends: number }>;
  /** Average number of backends idle inside an open transaction (app-side time while holding locks). */
  avgIdleInTransaction: number;
  maxConnections: number;
  maxActive: number;
  avgActive: number;
  maxLockWaits: number;
  avgLockWaits: number;
  maxOutboxPending: number;
  maxOutboxLagS: number;
}

export function analysePg(samples: PgSample[]): PgAnalysis {
  const waits = new Map<string, number>();
  let active = 0;
  let idleInTx = 0;
  let maxConnections = 0;
  let maxActive = 0;
  for (const s of samples) {
    let conns = 0;
    let act = 0;
    for (const b of s.backends) {
      conns += b.count;
      if (b.state === 'active') {
        act += b.count;
        const key = `${b.waitType}:${b.waitEvent}`;
        waits.set(key, (waits.get(key) ?? 0) + b.count);
      }
      if (b.state.startsWith('idle in transaction')) idleInTx += b.count;
    }
    active += act;
    maxConnections = Math.max(maxConnections, conns);
    maxActive = Math.max(maxActive, act);
  }
  const n = Math.max(samples.length, 1);
  return {
    samples: samples.length,
    activeWaits: [...waits.entries()]
      .map(([event, count]) => ({ event, share: count / Math.max(active, 1), avgBackends: count / n }))
      .sort((a, b) => b.share - a.share),
    avgIdleInTransaction: idleInTx / n,
    maxConnections,
    maxActive,
    avgActive: active / n,
    maxLockWaits: Math.max(0, ...samples.map((s) => s.lockWaits)),
    avgLockWaits: samples.reduce((sum, s) => sum + s.lockWaits, 0) / n,
    maxOutboxPending: Math.max(0, ...samples.map((s) => s.outboxPending)),
    maxOutboxLagS: Math.max(0, ...samples.map((s) => s.outboxLagS)),
  };
}

// ---------- docker stats samples ----------

export interface ContainerUsage {
  name: string;
  avgCpuPercent: number;
  maxCpuPercent: number;
  firstMemMiB: number;
  maxMemMiB: number;
  lastMemMiB: number;
}

/** Per container; CPU averaged over the samples in which the container was busy (> 1%). */
export function analyseContainers(samples: ContainerStat[][]): ContainerUsage[] {
  const byName = new Map<string, ContainerStat[]>();
  for (const sample of samples) for (const s of sample) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  return [...byName.entries()]
    .map(([name, stats]) => {
      const busy = stats.filter((s) => s.cpuPercent > 1);
      return {
        name,
        avgCpuPercent: busy.reduce((sum, s) => sum + s.cpuPercent, 0) / Math.max(busy.length, 1),
        maxCpuPercent: Math.max(...stats.map((s) => s.cpuPercent)),
        firstMemMiB: stats[0]?.memMiB ?? 0,
        maxMemMiB: Math.max(...stats.map((s) => s.memMiB)),
        lastMemMiB: stats.at(-1)?.memMiB ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
