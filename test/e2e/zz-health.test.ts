import { afterAll, describe, expect, test } from 'bun:test';
import { eventually } from '../support/eventually';
import { call } from '../support/http';
import { api, e2eEnabled, openWallet, reconcileAll } from './setup';

/** Named zz- so it runs after every other E2E file: it takes the database down for a while. */
const wallets: string[] = [];

async function compose(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', ...args], { stdout: 'ignore', stderr: 'inherit' });
  expect(await proc.exited).toBe(0);
}

async function allHealthy(): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', 'ps', '--format', 'json'], { stdout: 'pipe', stderr: 'inherit' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const containers = out
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as { Service: string; Health: string });
  const wanted = containers.filter((c) => ['api', 'consumer', 'workers', 'postgres', 'localstack'].includes(c.Service));
  expect(wanted.length).toBe(1 + 3 + 2 + 1 + 1);
  expect(wanted.filter((c) => c.Health !== 'healthy')).toEqual([]);
}

afterAll(async () => {
  if (!e2eEnabled) return;
  // Whatever happened above, leave the stack up and healthy for the next file.
  await compose('start', 'postgres');
  await eventually(() => allHealthy(), { timeoutMs: 90_000, intervalMs: 1_000 });
  await reconcileAll(wallets);
});

describe.skipIf(!e2eEnabled)('e2e: health', () => {
  test('ready drops to 503 while Postgres is stopped (live stays 200) and recovers after it returns', async () => {
    const wallet = await openWallet('50.00');
    wallets.push(wallet.id);
    expect((await call(api, 'GET', '/health/ready')).status).toBe(200);

    await compose('stop', 'postgres');
    await eventually(
      async () => {
        const ready = await call(api, 'GET', '/health/ready');
        expect(ready.status).toBe(503);
        expect(ready.body.checks?.database).toBe('down');
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    expect((await call(api, 'GET', '/health/live')).status).toBe(200);

    await compose('start', 'postgres');
    await eventually(async () => expect((await call(api, 'GET', '/health/ready')).status).toBe(200), {
      timeoutMs: 60_000,
      intervalMs: 500,
    });
    await eventually(() => allHealthy(), { timeoutMs: 90_000, intervalMs: 1_000 });
    // The data survived the outage.
    const res = await call(api, 'GET', `/wallets/${wallet.id}`);
    expect(res.body.balance.amount).toBe('50.00');
  });
});
