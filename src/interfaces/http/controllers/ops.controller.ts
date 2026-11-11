import { Controller, Get, Inject, Res } from '@nestjs/common';
import { HealthService, type Readiness } from '../../../infrastructure/observability/health';
import type { PromMetrics } from '../../../infrastructure/observability/metrics';
import type { HttpResponse } from '../http-types';
import { METRICS } from '../../tokens';

/** Health and metrics: public (NoopAuthGuard skips them). */
@Controller()
export class OpsController {
  constructor(
    private readonly health: HealthService,
    @Inject(METRICS) private readonly metrics: PromMetrics,
  ) {}

  @Get('health/live')
  live(): { status: 'ok' } {
    return this.health.live();
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: HttpResponse): Promise<Readiness> {
    const readiness = await this.health.ready();
    if (readiness.status !== 'ok') res.status(503);
    return readiness;
  }

  @Get('metrics')
  async scrape(@Res({ passthrough: true }) res: HttpResponse): Promise<string> {
    res.setHeader('content-type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
