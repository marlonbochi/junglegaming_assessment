import type { Subprocess } from 'bun';
import { eventually } from './eventually';

export type ServiceRole = 'api' | 'consumer' | 'workers';
export type StopSignal = 'SIGTERM' | 'SIGKILL';

export interface ServiceHandle {
  role: ServiceRole;
  port: number;
  baseUrl: string;
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Signals the process (default SIGTERM) and resolves with its exit code (128 + signal when killed). */
  kill(signal?: StopSignal): Promise<number>;
  /** The last lines the process wrote to stdout and stderr. */
  output(): string;
}

const ROOT = new URL('../..', import.meta.url).pathname;
const READY_TIMEOUT_MS = 30_000;
const TAIL_LINES = 60;

/** Every process spawned since the last `killAll`, to report and clean up. */
const spawned: ServiceHandle[] = [];
/** Processes whose output already travelled in an error. */
const reported = new WeakSet<ServiceHandle>();

// Never leave orphans behind, even when the test run itself dies.
process.once('exit', () => {
  for (const s of spawned) if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill('SIGKILL');
});

/** A port nothing listens on right now (bound on :0, then released). */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error('no free port');
  return port;
}

/**
 * Starts `bun src/main.<role>.ts` as a separate OS process with `process.env` plus `env`, on a free
 * port, and waits until its `/health/ready` answers 200.
 */
export async function spawnService(role: ServiceRole, env: Record<string, string>): Promise<ServiceHandle> {
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, `src/main.${role}.ts`], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const tail: string[] = [];
  const push = (line: string) => {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  };
  void collectLines(proc.stdout, push);
  void collectLines(proc.stderr, push);

  const handle: ServiceHandle = {
    role,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    proc,
    async kill(signal: StopSignal = 'SIGTERM') {
      if (!hasExited(proc)) proc.kill(signal);
      return proc.exited;
    },
    output: () => `--- ${role} :${port} (pid ${proc.pid}, exit ${proc.exitCode ?? proc.signalCode ?? 'running'}) ---\n${tail.join('\n')}`,
  };
  spawned.push(handle);

  const exitedEarly = proc.exited.then((code) => {
    throw new Error(`${role} exited with ${code} before becoming ready`);
  });
  const ready = eventually(
    async () => {
      if (hasExited(proc)) return;
      const res = await fetch(`${handle.baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      if (res.status !== 200) throw new Error(`/health/ready ${res.status}`);
    },
    { timeoutMs: READY_TIMEOUT_MS },
  );
  try {
    await Promise.race([ready, exitedEarly]);
  } catch (e) {
    proc.kill('SIGKILL');
    reported.add(handle);
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n${handle.output()}`);
  }
  exitedEarly.catch(() => {});
  return handle;
}

/** Starts `count` processes of `role` in parallel. */
export function spawnServices(role: ServiceRole, count: number, env: Record<string, string>): Promise<ServiceHandle[]> {
  return Promise.all(Array.from({ length: count }, () => spawnService(role, env)));
}

/** Kills every process still running (SIGKILL by default) and forgets them all. */
export async function killAll(signal: StopSignal = 'SIGKILL'): Promise<void> {
  await Promise.all(spawned.map((s) => s.kill(signal)));
  spawned.length = 0;
}

/** Wraps a test body: on failure, prints the output tail (and exit status) of every process it spawned. */
export function withServiceLogs(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      for (const s of spawned) if (!reported.has(s)) console.error(s.output());
      throw e;
    }
  };
}

/** Value of one exact series (e.g. `name{label="x"}`) on a process's `/metrics`; 0 when absent. */
export async function scrapeMetric(service: Pick<ServiceHandle, 'baseUrl'>, series: string): Promise<number> {
  const text = await (await fetch(`${service.baseUrl}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

function hasExited(proc: Subprocess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function collectLines(stream: ReadableStream<Uint8Array>, push: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let partial = '';
  for await (const chunk of stream) {
    partial += decoder.decode(chunk, { stream: true });
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) push(line);
  }
  if (partial) push(partial);
}
