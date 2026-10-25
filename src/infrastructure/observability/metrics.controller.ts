import { Controller, Get, Res, SetMetadata } from '@nestjs/common';
import type { Response } from 'express';
import { PrometheusMetrics } from './metrics';

/** Scrape do Prometheus: público (mesma chave de metadata que o @Public() do ProviderAuthGuard). */
@SetMetadata('wagering:isPublic', true)
@Controller()
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get('metrics')
  async scrape(@Res() res: Response): Promise<void> {
    const { contentType, body } = await this.metrics.render();
    res.setHeader('Content-Type', contentType);
    res.end(body);
  }
}
