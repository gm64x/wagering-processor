import { Global, Module } from '@nestjs/common';
import { APP_LOGGER, METRICS } from '../../application/ports';
import { MetricsController } from './metrics.controller';
import { PrometheusMetrics } from './metrics';
import { createLogger } from './logger';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    PrometheusMetrics,
    { provide: METRICS, useExisting: PrometheusMetrics },
    { provide: APP_LOGGER, useFactory: () => createLogger() },
  ],
  exports: [METRICS, APP_LOGGER, PrometheusMetrics],
})
export class ObservabilityModule {}
