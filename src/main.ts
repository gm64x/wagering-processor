import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_LOGGER, type AppLogger } from './application/ports';
import { NestPinoLoggerAdapter } from './infrastructure/observability/logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get<AppLogger>(APP_LOGGER);
  app.useLogger(new NestPinoLoggerAdapter(logger));
  // SIGTERM/SIGINT -> onModuleDestroy (consumer/publisher/worker terminam o que está em andamento) -> fecha o pool
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  logger.info('wagering service listening', { port });
}

bootstrap().catch((error: unknown) => {
  console.error('fatal: failed to start', error);
  process.exit(1);
});
