import { describe, expect, test } from 'bun:test';

const enabled = process.env.E2E_COMPOSE === '1';

type ComposeContainer = { Service: string; Health: string; State: string };

async function composeContainers(): Promise<ComposeContainer[]> {
  const proc = Bun.spawn(['docker', 'compose', 'ps', '--format', 'json'], { stdout: 'pipe', stderr: 'inherit' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as ComposeContainer);
}

describe.skipIf(!enabled)('compose stack (assumes `docker compose up --scale consumer=3 --scale workers=2 --wait` ran)', () => {
  test('api answers GET /health/ready with 200', async () => {
    const res = await fetch('http://localhost:3000/health/ready');
    expect(res.status).toBe(200);
  });

  test('3 consumer and 2 workers containers are healthy', async () => {
    const containers = await composeContainers();
    const healthy = (service: string) => containers.filter((c) => c.Service === service && c.Health === 'healthy').length;
    expect(healthy('consumer')).toBe(3);
    expect(healthy('workers')).toBe(2);
    expect(healthy('api')).toBe(1);
  });
});
