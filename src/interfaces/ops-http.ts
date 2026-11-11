import type { HealthService } from '../infrastructure/observability/health';
import type { PromMetrics } from '../infrastructure/observability/metrics';

/** Spec §3.2/§8: minimal health and metrics server for processes without the HTTP API. */
export function startOpsHttp(port: number, health: HealthService, metrics: PromMetrics): Bun.Server<undefined> {
  return Bun.serve({
    port,
    routes: {
      '/health/live': { GET: () => Response.json(health.live()) },
      '/health/ready': {
        GET: async () => {
          const readiness = await health.ready();
          return Response.json(readiness, { status: readiness.status === 'ok' ? 200 : 503 });
        },
      },
      '/metrics': {
        GET: async () =>
          new Response(await metrics.registry.metrics(), { headers: { 'content-type': metrics.registry.contentType } }),
      },
    },
    fetch: () => new Response('Not Found', { status: 404 }),
  });
}
