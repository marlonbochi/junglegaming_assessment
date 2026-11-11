import { docker, psql } from './docker';

/** Calls `sample` every `intervalMs` (never overlapping) until `stop()`; failed samples are counted, not fatal. */
export function sampleEvery<T>(intervalMs: number, sample: () => Promise<T>) {
  const samples: Array<{ t: number; value: T }> = [];
  let failures = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const started = Date.now();
      try {
        samples.push({ t: started, value: await sample() });
      } catch {
        failures++;
      }
      await Bun.sleep(Math.max(0, intervalMs - (Date.now() - started)));
    }
  })();
  return {
    samples,
    async stop() {
      running = false;
      await loop;
      return { samples, failures };
    },
  };
}

export interface PgSample {
  /** Client backends of the `wagering` database by state and wait event. */
  backends: Array<{ waitType: string; waitEvent: string; state: string; count: number }>;
  lockWaits: number;
  outboxPending: number;
  outboxLagS: number;
}

const PG_SAMPLE_SQL = `
SELECT 'b', coalesce(wait_event_type, 'CPU'), coalesce(wait_event, '-'), coalesce(state, '-'), count(*)
  FROM pg_stat_activity
 WHERE datname = 'wagering' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
 GROUP BY 2, 3, 4
UNION ALL
SELECT 'l', '-', '-', '-', count(*) FROM pg_locks WHERE NOT granted
UNION ALL
SELECT 'o', '-', '-', coalesce(extract(epoch FROM now() - min(occurred_at))::text, '0'), count(*)
  FROM outbox_messages WHERE published_at IS NULL`;

/** One `pg_stat_activity` / `pg_locks` / outbox snapshot (via `docker compose exec postgres psql`). */
export async function pgSample(): Promise<PgSample> {
  const sample: PgSample = { backends: [], lockWaits: 0, outboxPending: 0, outboxLagS: 0 };
  for (const [kind, waitType = '', waitEvent = '', state = '', count = '0'] of await psql(PG_SAMPLE_SQL)) {
    if (kind === 'b') sample.backends.push({ waitType, waitEvent, state, count: Number(count) });
    if (kind === 'l') sample.lockWaits = Number(count);
    if (kind === 'o') {
      sample.outboxPending = Number(count);
      sample.outboxLagS = Number(state);
    }
  }
  return sample;
}

export interface ContainerStat {
  name: string;
  cpuPercent: number;
  memMiB: number;
}

const UNITS: Record<string, number> = { B: 1 / 1024 / 1024, KiB: 1 / 1024, kB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };

function mebibytes(usage: string): number {
  const m = /^([\d.]+)\s*([A-Za-z]+)/.exec(usage.split('/')[0]?.trim() ?? '');
  return m ? Number(m[1]) * (UNITS[m[2] ?? ''] ?? 0) : 0;
}

/** CPU and memory of this stack's containers (`docker stats --no-stream`; 100% = one core). */
export async function dockerStats(): Promise<ContainerStat[]> {
  const run = await docker(['stats', '--no-stream', '--format', '{{json .}}']);
  if (run.code !== 0) throw new Error(run.stderr);
  return run.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { Name: string; CPUPerc: string; MemUsage: string })
    .filter((s) => /^wagering-(?!test-)/.test(s.Name))
    .map((s) => ({ name: s.Name, cpuPercent: Number.parseFloat(s.CPUPerc), memMiB: mebibytes(s.MemUsage) }));
}
