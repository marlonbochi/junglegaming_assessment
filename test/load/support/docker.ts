import { resolve } from 'node:path';

/** Repository root: compose files and the k6 volume mounts are relative to it. */
export const ROOT = resolve(import.meta.dir, '../../..');
const COMPOSE = ['docker', 'compose', '-f', 'compose.yml', '-f', 'compose.load.yml'];

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(cmd: string[], opts: { inherit?: boolean } = {}): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: opts.inherit ? 'inherit' : 'pipe',
    stderr: opts.inherit ? 'inherit' : 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    opts.inherit ? '' : new Response(proc.stdout as ReadableStream).text(),
    opts.inherit ? '' : new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** `docker compose -f compose.yml -f compose.load.yml <args>`; throws on a non-zero exit unless `allowFail`. */
export async function compose(args: string[], opts: { inherit?: boolean; allowFail?: boolean } = {}): Promise<Run> {
  const run = await exec([...COMPOSE, ...args], opts);
  if (run.code !== 0 && !opts.allowFail) {
    throw new Error(`docker compose ${args.join(' ')} exited ${run.code}\n${run.stderr}`);
  }
  return run;
}

export const docker = (args: string[]) => exec(['docker', ...args]);

/** Rows of a query run by `psql` inside the postgres container, fields split on `|`. */
export async function psql(sql: string): Promise<string[][]> {
  const run = await compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'wagering', '-AtF', '|', '-c', sql]);
  return run.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('|'));
}

export async function containerIds(service: string): Promise<string[]> {
  const run = await compose(['ps', '-q', service]);
  return run.stdout.split('\n').filter((id) => id.length > 0);
}

/** `/metrics` of a container that publishes no port, fetched from inside it. */
export async function metricsFromContainer(id: string): Promise<string> {
  const script = "fetch('http://localhost:'+process.env.PORT+'/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))";
  const run = await docker(['exec', id, 'bun', '-e', script]);
  if (run.code !== 0) throw new Error(`metrics of ${id} failed: ${run.stderr}`);
  return run.stdout;
}
