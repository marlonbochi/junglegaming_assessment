import type { Capacity, ContainerUsage, HttpSummary, Latency, PgAnalysis, ServiceMetrics, Slice } from './analysis';

export interface Environment {
  cpu: string;
  cores: number;
  memoryGiB: number;
  os: string;
  docker: string;
  dockerVm: string;
  k6: string;
  bun: string;
  postgres: string;
  localstack: string;
}

export interface ScenarioResult {
  name: string;
  startedAt: string;
  finishedAt: string;
  config: Record<string, string | number>;
  http?: HttpSummary;
  slices?: Slice[];
  counters?: Record<string, number>;
  metrics?: ServiceMetrics;
  db?: Record<string, number>;
  pg?: PgAnalysis;
  containers?: ContainerUsage[];
  outboxCatchUpS?: number | null;
  /** Failed pg_stat_activity / docker stats samples (absent in runs before this field existed). */
  samplerFailures?: Record<string, number>;
  capacity?: Capacity;
  drain?: Array<{
    consumers: number;
    enqueued: number;
    enqueueSeconds: number;
    queuedBeforeStart: number;
    startupSeconds: number;
    drainSeconds: number;
    drain99Seconds: number;
    messagesPerSecond: number;
    outboxCatchUpS: number | null;
    transactionsByStatus: Record<string, number>;
    dlqDepth: number;
    samplerFailures?: Record<string, number>;
    metrics: ServiceMetrics;
    pg: PgAnalysis;
    containers: ContainerUsage[];
  }>;
  reconciliation: { checked: number; inconsistent: number };
  failures: string[];
  raw: unknown;
}

const f = (n: number | null | undefined, digits = 1) => (n === undefined || n === null || Number.isNaN(n) ? '—' : n.toFixed(digits));
const pct = (n: number | undefined) => (n === undefined ? '—' : `${(n * 100).toFixed(2)}%`);
const ms = (l: Latency) => `${f(l.med)} / ${f(l.p95)} / ${f(l.p99)}`;
const kv = (o: Record<string, number> | undefined) =>
  o && Object.keys(o).length > 0
    ? Object.entries(o)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
    : '0';

function containersTable(rows: ContainerUsage[]): string[] {
  return [
    '| Container | CPU médio (busy) | CPU máx | Mem início → máx → fim (MiB) |',
    '|---|---|---|---|',
    ...rows.map(
      (c) => `| ${c.name} | ${f(c.avgCpuPercent)}% | ${f(c.maxCpuPercent)}% | ${f(c.firstMemMiB, 0)} → ${f(c.maxMemMiB, 0)} → ${f(c.lastMemMiB, 0)} |`,
    ),
  ];
}

const samplerLine = (failures: Record<string, number> | undefined) =>
  failures && Object.values(failures).some((n) => n > 0) ? [`- **Amostras com falha**: ${kv(failures)}`] : [];

function pgLines(pg: PgAnalysis): string[] {
  return [
    `- Amostras: ${pg.samples}; conexões máx ${pg.maxConnections}; ativas média ${f(pg.avgActive)} / máx ${pg.maxActive}; idle in transaction média ${f(pg.avgIdleInTransaction)}`,
    `- Locks não concedidos: média ${f(pg.avgLockWaits)} / máx ${pg.maxLockWaits}; outbox pendente máx ${pg.maxOutboxPending}; outbox lag máx ${f(pg.maxOutboxLagS)} s`,
    `- Esperas dos backends ativos: ${pg.activeWaits
      .slice(0, 6)
      .map((w) => `${w.event} ${pct(w.share)}`)
      .join(', ')}`,
  ];
}

function metricsLines(m: ServiceMetrics): string[] {
  return [
    `- db_lock_conflicts_total Δ ${m.lockConflicts}; wagering_retries_total Δ ${kv(m.retries)}; sqs_dlq_messages_total Δ ${kv(m.dlq)}`,
    `- wagering_transactions_total Δ ${kv(m.transactions)}; wagering_duplicates_total Δ ${kv(m.duplicates)}`,
    ...Object.entries(m.processingMs).map(
      ([source, p]) => `- Processamento no serviço (${source}): média ${f(p.mean)} ms, p50 ${f(p.p50)} / p95 ${f(p.p95)} / p99 ${f(p.p99)} ms (buckets do histograma)`,
    ),
  ];
}

function scenarioSection(r: ScenarioResult): string[] {
  const out = [`## ${r.name}`, '', `Config: ${kv(r.config as Record<string, number>)}. Resultado: ${r.failures.length === 0 ? '**PASS**' : `**FAIL** — ${r.failures.join('; ')}`}`, ''];
  if (r.http) {
    const h = r.http;
    out.push(
      '| Requisições | RPS médio | p50 / p95 / p99 (ms) | máx (ms) | Erro (http_req_failed) | 2xx | 422 | 4xx inesperado | 5xx | sem resposta | dropped iterations | checks de correção |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      `| ${h.requests} | ${f(h.rps)} | ${ms(h.latencyMs)} | ${f(h.latencyMs.max)} | ${pct(h.errorRate)} | ${h.responses.ok2xx} | ${h.responses.rejected422} | ${h.responses.unexpected4xx} | ${h.responses.server5xx} | ${h.responses.noStatus} | ${h.droppedIterations} | ${h.correctness.passes}/${h.correctness.passes + h.correctness.fails} |`,
      '',
    );
  }
  if (r.slices && r.slices.length > 0) {
    out.push('| Fatia | Requisições | RPS | p50 / p95 / p99 (ms) | máx (ms) | Erro |', '|---|---|---|---|---|---|');
    for (const s of r.slices) out.push(`| ${s.tag} | ${s.requests} | ${f(s.rps)} | ${ms(s.latencyMs)} | ${f(s.latencyMs.max)} | ${pct(s.errorRate)} |`);
    out.push('');
  }
  if (r.capacity) {
    out.push(
      `Capacidade com latência (≥ 97% da taxa-alvo, erro < 1%, p95 ≤ 100 ms): **${r.capacity.sustainableRps} req/s**; primeiro degrau fora: ${r.capacity.saturatedAt ?? 'nenhum'}. Throughput máximo atingido: **${f(r.capacity.maxThroughputRps)} req/s**.`,
      '',
    );
  }
  if (r.counters?.duplicatesSent) out.push(`Duplicatas enviadas pelo k6: ${r.counters.duplicatesSent}.`, '');
  if (r.metrics) out.push(...metricsLines(r.metrics));
  if (r.outboxCatchUpS !== undefined) out.push(`- Outbox zerada ${f(r.outboxCatchUpS)} s após o fim da carga`);
  if (r.db) out.push(`- pg_stat_database Δ: ${kv(r.db)}`);
  if (r.pg) out.push(...pgLines(r.pg));
  out.push(...samplerLine(r.samplerFailures));
  if (r.containers) out.push('', ...containersTable(r.containers));
  for (const d of r.drain ?? []) {
    out.push(
      '',
      `### consumer=${d.consumers}`,
      '',
      `- Enfileiradas ${d.enqueued} em ${f(d.enqueueSeconds)} s (k6 + SendMessageBatch); na fila ao iniciar: ${d.queuedBeforeStart}`,
      `- Partida dos consumers até a 1ª mensagem sair: ${f(d.startupSeconds)} s; drenagem: **${f(d.drainSeconds)} s** (${f(d.messagesPerSecond)} msg/s); 99% drenado em ${f(d.drain99Seconds)} s (${f((0.99 * d.queuedBeforeStart) / d.drain99Seconds)} msg/s)`,
      `- Outbox zerada ${f(d.outboxCatchUpS)} s após a fila esvaziar; transações persistidas (acumulado): ${kv(d.transactionsByStatus)}; DLQ: ${d.dlqDepth}`,
      ...metricsLines(d.metrics),
      ...pgLines(d.pg),
      ...samplerLine(d.samplerFailures),
      '',
      ...containersTable(d.containers),
    );
  }
  out.push('', `Reconciliação: ${r.reconciliation.checked} wallets, ${r.reconciliation.inconsistent} inconsistentes.`, '');
  return out;
}

/** The environment header of `summary.md`. */
export function renderEnvironment(env: Environment): string[] {
  return [
    `- Host: ${env.cpu}, ${env.cores} cores, ${f(env.memoryGiB)} GiB, ${env.os}`,
    `- Docker ${env.docker}; VM: ${env.dockerVm}`,
    `- k6: ${env.k6}; Bun ${env.bun}; PostgreSQL ${env.postgres}; LocalStack ${env.localstack}`,
  ];
}

/** `environment`: the header lines, already rendered (see `renderEnvironment`). */
export function renderSummary(environment: string[], results: ScenarioResult[]): string {
  return ['# Load test summary', '', ...environment, '', ...results.flatMap(scenarioSection)].join('\n');
}
