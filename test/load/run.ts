/**
 * `bun run test:load [--scenario <name>] [--consumers N] [--rate N] [--levels a,b,c] [--messages N] [--minutes N]`
 *
 * Spec §10.2. For each scenario: fresh `compose.yml` + `compose.load.yml` stack (fixed CPU/memory
 * limits) → wallets seeded through `POST /wallets` → k6 (`grafana/k6`, on the compose network) with
 * `--summary-export` → `/metrics` of every process before/after, `pg_stat_activity` and `docker stats`
 * sampled during the run → outbox catch-up → reconciliation of every seeded wallet (any
 * `consistent: false` fails the run) → `test/load/results/<timestamp>/<scenario>.json` and `summary.md`
 * → `docker compose down -v`.
 *
 * Default: every scenario except `soak`. `--scenario soak` runs the soak at ~50% of the capacity found
 * by the latest `distributed` result (or `--rate`).
 */
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mkdir, readdir } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyseContainers,
  analysePg,
  capacityOf,
  countOf,
  failedThresholds,
  httpSummary,
  serviceMetrics,
  sliceOf,
  type K6Export,
} from './support/analysis';
import { ROOT, compose, containerIds, docker, metricsFromContainer, psql } from './support/docker';
import { delta, merge, parsePrometheus, type Series } from './support/prometheus';
import { renderEnvironment, renderSummary, type Environment, type ScenarioResult } from './support/report';
import { dockerStats, pgSample, sampleEvery } from './support/samplers';

const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' },
    consumers: { type: 'string' },
    rate: { type: 'string' },
    levels: { type: 'string' },
    messages: { type: 'string' },
    minutes: { type: 'string' },
  },
});

const API = 'http://localhost:3000';
const RESULTS = join(ROOT, 'test/load/results');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(RESULTS, stamp);
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4567',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const queueUrl = (name: string) => `http://localhost:4567/000000000000/${name}`;

const log = (msg: string) => console.log(`[load ${new Date().toISOString().slice(11, 19)}] ${msg}`);

interface Wallet {
  id: string;
  playerId: string;
}

// ---------- stack ----------

async function stackUp(consumers: number): Promise<void> {
  log(`stack up (consumer=${consumers})`);
  await compose(['up', '-d', '--wait', '--scale', `consumer=${consumers}`]);
}

async function stackDown(): Promise<void> {
  // `down` leaves a running `compose run` container (k6) and its network behind: remove one-offs first.
  const oneOffs = await docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=wagering', '--filter', 'label=com.docker.compose.oneoff=True']);
  const ids = oneOffs.stdout.split('\n').filter((id) => id.length > 0);
  if (ids.length > 0) await docker(['rm', '-f', ...ids]);
  await compose(['down', '-v', '--remove-orphans'], { allowFail: true });
}

/** Starts or stops consumers only (fresh containers: scaling to 0 removes them). */
async function scaleConsumers(n: number): Promise<void> {
  await compose(['up', '-d', '--wait', '--no-deps', '--scale', `consumer=${n}`, 'consumer']);
}

// ---------- API ----------

async function inParallel<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

async function seedWallets(n: number, initialBalance: string): Promise<Wallet[]> {
  const wallets = await inParallel(Array.from({ length: n }), 20, async () => {
    const res = await fetch(`${API}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: initialBalance, currency: 'BRL' } }),
    });
    if (res.status !== 201) throw new Error(`POST /wallets → ${res.status} ${await res.text()}`);
    const body = (await res.json()) as Wallet;
    return { id: body.id, playerId: body.playerId };
  });
  log(`seeded ${wallets.length} wallets with ${initialBalance}`);
  return wallets;
}

interface Reconciliation {
  checked: number;
  inconsistent: Array<{ walletId: string; body: unknown }>;
}

async function reconcile(wallets: Wallet[]): Promise<Reconciliation> {
  const inconsistent: Reconciliation['inconsistent'] = [];
  await inParallel(wallets, 20, async (w) => {
    const res = await fetch(`${API}/wallets/${w.id}/reconciliation`, { method: 'POST' });
    const body = (await res.json()) as { consistent?: boolean };
    if (res.status !== 200 || body.consistent !== true) inconsistent.push({ walletId: w.id, body });
  });
  log(`reconciled ${wallets.length} wallets: ${inconsistent.length} inconsistent`);
  return { checked: wallets.length, inconsistent };
}

// ---------- observation ----------

/** `/metrics` of api (published port) plus every consumer and workers container, summed. */
async function scrape(): Promise<Series[]> {
  const api = parsePrometheus(await (await fetch(`${API}/metrics`)).text());
  const ids = [...(await containerIds('consumer')), ...(await containerIds('workers'))];
  const others = await Promise.all(ids.map(async (id) => parsePrometheus(await metricsFromContainer(id))));
  return merge(api, ...others);
}

const DB_STATS_SQL = `SELECT xact_commit, xact_rollback, deadlocks, tup_inserted, tup_updated, blks_read, blks_hit
  FROM pg_stat_database WHERE datname = 'wagering'`;
const DB_STATS_KEYS = ['xactCommit', 'xactRollback', 'deadlocks', 'tupInserted', 'tupUpdated', 'blksRead', 'blksHit'] as const;

async function dbStats(): Promise<Record<string, number>> {
  const [row = []] = await psql(DB_STATS_SQL);
  return Object.fromEntries(DB_STATS_KEYS.map((k, i) => [k, Number(row[i])]));
}

const diff = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, (a[k] ?? 0) - (b[k] ?? 0)]));

/** pg (1 s) and docker stats (~3 s) samplers, with a progress line every ~10 s. */
function startObservers() {
  let n = 0;
  const pg = sampleEvery('pg_stat_activity', 1000, async () => {
    const s = await pgSample();
    if (n++ % 10 === 0) {
      const active = s.backends.filter((b) => b.state === 'active').reduce((sum, b) => sum + b.count, 0);
      log(`  pg: ${active} active, ${s.lockWaits} lock waits, outbox pending ${s.outboxPending} (lag ${s.outboxLagS.toFixed(1)}s)`);
    }
    return s;
  });
  const stats = sampleEvery('docker stats', 3000, dockerStats);
  return {
    async stop() {
      const [p, d] = await Promise.all([pg.stop(), stats.stop()]);
      const problems: string[] = [];
      for (const [name, r] of [['pg_stat_activity', p], ['docker stats', d]] as const) {
        if (r.samples.length === 0) problems.push(`no ${name} samples (${r.failures} failed): the evidence is missing`);
      }
      return { pg: p, stats: d, samplerFailures: { pg: p.failures, dockerStats: d.failures }, problems };
    },
  };
}

/** Seconds until every outbox message is published (the load is over; the publisher catches up). */
async function outboxCatchUp(timeoutMs = 300_000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [[pending = '0'] = []] = await psql('SELECT count(*) FROM outbox_messages WHERE published_at IS NULL');
    if (Number(pending) === 0) return (Date.now() - started) / 1000;
    await Bun.sleep(1000);
  }
  return null;
}

async function queueDepth(name: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl(name),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return { visible: Number(Attributes.ApproximateNumberOfMessages), inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible) };
}

// ---------- k6 ----------

async function runK6(script: string, label: string, env: Record<string, string>): Promise<{ code: number; summary: K6Export }> {
  const exportPath = `/results/${stamp}/${label}.k6.json`;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  log(`k6 run ${script} ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const run = await compose(
    ['--profile', 'load', 'run', '--rm', '--no-deps', ...envArgs, 'k6', 'run', '--quiet', '--no-color', '--summary-export', exportPath, `/scripts/${script}`],
    { inherit: true, allowFail: true },
  );
  const summary = (await Bun.file(join(outDir, `${label}.k6.json`)).json()) as K6Export;
  log(`k6 exited ${run.code}`);
  return { code: run.code, summary };
}

// ---------- scenarios ----------

interface HttpScenario {
  name: string;
  script: string;
  wallets: number;
  balance: string;
  env: Record<string, string>;
  /** Tagged slices to report: `[tag, seconds the slice lasts]`. */
  slices: Array<[string, number]>;
}

async function runHttpScenario(s: HttpScenario, consumers: number): Promise<ScenarioResult> {
  const failures: string[] = [];
  const startedAt = new Date().toISOString();
  await stackDown();
  await stackUp(consumers);
  try {
    const wallets = await seedWallets(s.wallets, s.balance);
    await Bun.write(join(outDir, `${s.name}.wallets.json`), JSON.stringify(wallets));
    const before = await scrape();
    const dbBefore = await dbStats();
    const observers = startObservers();
    const k6 = await runK6(s.script, s.name, { ...s.env, WALLETS_FILE: `/results/${stamp}/${s.name}.wallets.json` });
    const observed = await observers.stop();
    failures.push(...observed.problems);
    const outboxCatchUpS = await outboxCatchUp();
    const after = await scrape();
    const db = diff(await dbStats(), dbBefore);
    const reconciliation = await reconcile(wallets);

    if (k6.code !== 0) failures.push(`k6 exited ${k6.code}: ${failedThresholds(k6.summary).join('; ') || 'see output'}`);
    if (reconciliation.inconsistent.length > 0) failures.push(`${reconciliation.inconsistent.length} wallets inconsistent`);
    if (outboxCatchUpS === null) failures.push('outbox did not drain within 5 min');
    const metrics = serviceMetrics(delta(after, before));
    const duplicatesSent = countOf(k6.summary, 'duplicates_sent');
    if ((metrics.duplicates.replay ?? 0) !== duplicatesSent) {
      failures.push(`${duplicatesSent} duplicates sent, ${metrics.duplicates.replay ?? 0} replays counted by the service`);
    }

    return {
      name: s.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      config: { ...s.env, wallets: s.wallets, initialBalance: s.balance, consumers },
      http: httpSummary(k6.summary),
      slices: s.slices.map(([tag, seconds]) => sliceOf(k6.summary, tag, seconds)),
      counters: { duplicatesSent },
      metrics,
      db,
      pg: analysePg(observed.pg.samples.map((x) => x.value)),
      containers: analyseContainers(observed.stats.samples.map((x) => x.value)),
      samplerFailures: observed.samplerFailures,
      outboxCatchUpS,
      reconciliation: { checked: reconciliation.checked, inconsistent: reconciliation.inconsistent.length },
      failures,
      raw: { pg: observed.pg.samples, stats: observed.stats.samples, inconsistent: reconciliation.inconsistent },
    };
  } finally {
    await stackDown();
  }
}

interface DrainRound {
  consumers: number;
  enqueued: number;
  enqueueSeconds: number;
  queuedBeforeStart: number;
  /** Consumers started → first message gone (container boot + first receive). */
  startupSeconds: number;
  /** First message gone → queue empty (visible + in flight = 0), ±1 s sampling. */
  drainSeconds: number;
  messagesPerSecond: number;
  outboxCatchUpS: number | null;
  transactionsByStatus: Record<string, number>;
  dlqDepth: number;
  metrics: ReturnType<typeof serviceMetrics>;
  pg: ReturnType<typeof analysePg>;
  containers: ReturnType<typeof analyseContainers>;
  /** First message gone → ≤ 1% of the messages left (bulk throughput, without the tail). */
  drain99Seconds: number;
  samplerFailures: Record<string, number>;
  queueTimeline: Array<{ t: number; visible: number; inFlight: number }>;
}

async function runDrain(messages: number, rounds: number[]): Promise<ScenarioResult> {
  const failures: string[] = [];
  const startedAt = new Date().toISOString();
  const name = 'sqs-drain';
  await stackDown();
  await stackUp(0);
  try {
    const wallets = await seedWallets(1000, '1000000.00');
    await Bun.write(join(outDir, `${name}.wallets.json`), JSON.stringify(wallets));
    const results: DrainRound[] = [];
    let expected = 0;
    for (const consumers of rounds) {
      const enqueueStarted = Date.now();
      const k6 = await runK6('sqs-drain.js', `${name}-c${consumers}`, {
        MESSAGES: String(messages),
        WALLETS_FILE: `/results/${stamp}/${name}.wallets.json`,
      });
      const enqueueSeconds = (Date.now() - enqueueStarted) / 1000;
      const enqueued = countOf(k6.summary, 'messages_enqueued');
      expected += enqueued;
      if (k6.code !== 0) failures.push(`enqueue (consumer=${consumers}) k6 exited ${k6.code}: ${failedThresholds(k6.summary).join('; ')}`);
      const initial = await queueDepth('wager-transactions.fifo');
      const queuedBeforeStart = initial.visible + initial.inFlight;
      log(`queue holds ${queuedBeforeStart} messages; starting ${consumers} consumer(s)`);

      const before = await scrape();
      const observers = startObservers();
      const timeline: DrainRound['queueTimeline'] = [];
      const t0 = Date.now();
      const scaling = scaleConsumers(consumers);
      let firstDrop: number | undefined;
      let drained99: number | undefined;
      let empty: number | undefined;
      while (Date.now() - t0 < 30 * 60_000) {
        const d = await queueDepth('wager-transactions.fifo');
        const remaining = d.visible + d.inFlight;
        timeline.push({ t: Date.now() - t0, ...d });
        if (firstDrop === undefined && remaining < queuedBeforeStart) firstDrop = Date.now();
        if (drained99 === undefined && remaining <= queuedBeforeStart / 100) drained99 = Date.now();
        if (remaining === 0) {
          empty = Date.now();
          break;
        }
        if (timeline.length % 15 === 0) log(`  queue: ${d.visible} visible, ${d.inFlight} in flight`);
        await Bun.sleep(1000);
      }
      await scaling;
      const after = await scrape();
      const observed = await observers.stop();
      failures.push(...observed.problems.map((p) => `consumer=${consumers}: ${p}`));
      const outboxCatchUpS = await outboxCatchUp();
      const rows = await psql("SELECT status, count(*) FROM wager_transactions WHERE provider_id = 'provider-load' GROUP BY status");
      const transactionsByStatus = Object.fromEntries(rows.map(([status = '', count = '0']) => [status, Number(count)]));
      const dlq = await queueDepth('wager-transactions-dlq.fifo');
      await scaleConsumers(0);

      if (empty === undefined || firstDrop === undefined) failures.push(`consumer=${consumers}: queue not drained in 30 min`);
      const decided = Object.values(transactionsByStatus).reduce((a, b) => a + b, 0);
      if (decided !== expected) failures.push(`consumer=${consumers}: ${decided} transactions persisted, ${expected} messages sent`);
      if ((transactionsByStatus.PENDING_REFERENCE ?? 0) + (transactionsByStatus.PENDING ?? 0) > 0) {
        failures.push(`consumer=${consumers}: transactions left pending`);
      }
      if (dlq.visible + dlq.inFlight > 0) failures.push(`consumer=${consumers}: ${dlq.visible + dlq.inFlight} messages in the DLQ`);
      if (outboxCatchUpS === null) failures.push(`consumer=${consumers}: outbox did not drain within 5 min`);

      const drainSeconds = empty !== undefined && firstDrop !== undefined ? (empty - firstDrop) / 1000 : NaN;
      results.push({
        consumers,
        enqueued,
        enqueueSeconds,
        queuedBeforeStart,
        startupSeconds: firstDrop !== undefined ? (firstDrop - t0) / 1000 : NaN,
        drainSeconds,
        drain99Seconds: drained99 !== undefined && firstDrop !== undefined ? (drained99 - firstDrop) / 1000 : NaN,
        messagesPerSecond: queuedBeforeStart / drainSeconds,
        outboxCatchUpS,
        transactionsByStatus,
        dlqDepth: dlq.visible + dlq.inFlight,
        metrics: serviceMetrics(delta(after, before)),
        pg: analysePg(observed.pg.samples.map((x) => x.value)),
        containers: analyseContainers(observed.stats.samples.map((x) => x.value)),
        samplerFailures: observed.samplerFailures,
        queueTimeline: timeline,
      });
      log(`consumer=${consumers}: drained ${queuedBeforeStart} in ${drainSeconds.toFixed(1)}s`);
    }
    const reconciliation = await reconcile(wallets);
    if (reconciliation.inconsistent.length > 0) failures.push(`${reconciliation.inconsistent.length} wallets inconsistent`);
    return {
      name,
      startedAt,
      finishedAt: new Date().toISOString(),
      config: { messages, rounds: rounds.join(','), wallets: 1000, initialBalance: '1000000.00' },
      drain: results,
      reconciliation: { checked: reconciliation.checked, inconsistent: reconciliation.inconsistent.length },
      failures,
      raw: { inconsistent: reconciliation.inconsistent },
    };
  } finally {
    await stackDown();
  }
}

// ---------- configuration ----------

const LEVELS = (args.levels ?? '100,200,300,400,500,600,700').split(',').map(Number);
const RAMP_S = 5;
const HOLD_S = 30;
const stageTag = (level: number) => `stage:L${String(level).padStart(4, '0')}`;

async function latestCapacity(): Promise<number | undefined> {
  const dirs = (await readdir(RESULTS).catch(() => [] as string[])).sort().reverse();
  for (const dir of dirs) {
    const file = Bun.file(join(RESULTS, dir, 'distributed.json'));
    if (await file.exists()) {
      const result = (await file.json()) as ScenarioResult;
      if (result.capacity) return result.capacity.maxThroughputRps;
    }
  }
  return undefined;
}

async function environment(): Promise<Environment> {
  const text = async (p: Promise<{ stdout: string }>) => (await p).stdout.trim();
  const [k6, bun, postgres, localstack] = await Promise.all([
    text(compose(['--profile', 'load', 'run', '--rm', '--no-deps', 'k6', 'version'], { allowFail: true })),
    text(compose(['exec', '-T', 'api', 'bun', '--version'], { allowFail: true })),
    psql('SHOW server_version').then((r) => r[0]?.[0] ?? '?'),
    fetch('http://localhost:4567/_localstack/health')
      .then((r) => r.json() as Promise<{ version?: string }>)
      .then((h) => h.version ?? '?'),
  ]);
  const macos =
    platform() === 'darwin' ? (await new Response(Bun.spawn(['sw_vers', '-productVersion']).stdout).text()).trim() : '';
  return {
    cpu: cpus()[0]?.model ?? '?',
    cores: cpus().length,
    memoryGiB: totalmem() / 1024 ** 3,
    os: platform() === 'darwin' ? `macOS ${macos}` : `${platform()} ${release()}`,
    docker: await text(docker(['version', '--format', '{{.Server.Version}}'])),
    dockerVm: await text(docker(['info', '--format', '{{.NCPU}} CPUs, {{.MemTotal}} bytes, {{.OperatingSystem}}'])),
    k6,
    bun,
    postgres,
    localstack,
  };
}

// ---------- main ----------

async function main(): Promise<void> {
  const consumers = args.consumers ? Number(args.consumers) : undefined;
  const requested = args.scenario === 'drain' ? 'sqs-drain' : args.scenario;
  const all = ['distributed', 'hot-wallet', 'duplicates', 'sqs-drain'];
  const names = requested ? [requested] : all;
  const known = [...all, 'soak'];
  for (const n of names) if (!known.includes(n)) throw new Error(`unknown scenario ${n} (known: ${known.join(', ')}, drain)`);

  await mkdir(outDir, { recursive: true });
  log(`results → ${outDir}`);
  log('building images');
  await compose(['build', '--quiet']);
  await stackDown();
  await stackUp(1);
  const env = await environment();
  await Bun.write(join(outDir, 'environment.json'), JSON.stringify(env, null, 2));
  await stackDown();

  const results: ScenarioResult[] = [];
  for (const name of names) {
    let result: ScenarioResult;
    switch (name) {
      case 'distributed': {
        result = await runHttpScenario(
          {
            name,
            script: 'distributed.js',
            wallets: 1000,
            balance: '1000000.00',
            env: { LEVELS: LEVELS.join(','), RAMP_S: String(RAMP_S), HOLD_S: String(HOLD_S) },
            slices: LEVELS.map((l) => [stageTag(l), HOLD_S]),
          },
          consumers ?? 1,
        );
        result.capacity = capacityOf(result.slices, LEVELS);
        break;
      }
      case 'hot-wallet': {
        const rate = args.rate ?? '200';
        result = await runHttpScenario(
          {
            name,
            script: 'hot-wallet.js',
            wallets: 11,
            balance: '1000.00',
            env: { RATE: rate, DURATION: '90s', HOT1_START: '95s', HIGH_RATE: '400', HIGH_DURATION: '60s', HOT1HIGH_START: '190s' },
            slices: [
              ['phase:hot10', 90],
              ['phase:hot1', 90],
              ['phase:hot1high', 60],
            ],
          },
          consumers ?? 1,
        );
        break;
      }
      case 'duplicates':
        result = await runHttpScenario(
          {
            name,
            script: 'duplicates.js',
            wallets: 1000,
            balance: '1000000.00',
            env: { RATE: args.rate ?? '150', DURATION: '120s' },
            slices: [
              ['dup:no', 120],
              ['dup:replay', 120],
              ['dup:pair', 120],
            ],
          },
          consumers ?? 1,
        );
        break;
      case 'sqs-drain':
        result = await runDrain(Number(args.messages ?? 50_000), consumers ? [consumers] : [1, 3]);
        break;
      default: {
        const minutes = Number(args.minutes ?? 10);
        const capacity = await latestCapacity();
        const rate = args.rate ?? String(Math.max(10, Math.round((capacity ?? 400) / 2)));
        const basis = args.rate ? '--rate' : `50% of ${capacity?.toFixed(0) ?? 'the default 400'} req/s`;
        log(`soak at ${rate} req/s for ${minutes} min (${basis})`);
        result = await runHttpScenario(
          {
            name,
            script: 'soak.js',
            wallets: 1000,
            balance: '1000000.00',
            env: { RATE: rate, MINUTES: String(minutes) },
            slices: Array.from({ length: minutes }, (_, m): [string, number] => [`minute:m${String(m).padStart(2, '0')}`, 60]),
          },
          consumers ?? 1,
        );
      }
    }
    results.push(result);
    await Bun.write(join(outDir, `${name}.json`), JSON.stringify(result, null, 2));
    log(`${name}: ${result.failures.length === 0 ? 'PASS' : `FAIL — ${result.failures.join('; ')}`}`);
  }

  await Bun.write(join(outDir, 'summary.md'), renderSummary(renderEnvironment(env), results));
  log(`summary → ${join(outDir, 'summary.md')}`);
  const failed = results.filter((r) => r.failures.length > 0);
  if (failed.length > 0) {
    log(`FAILED: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
}

// Ctrl-C or a kill must not leave the `wagering` stack running: same teardown as a failure.
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (interrupted) return;
    interrupted = true;
    log(`${signal}: tearing the stack down`);
    await stackDown();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

await main().catch(async (e) => {
  console.error(e);
  await stackDown();
  process.exit(1);
});
