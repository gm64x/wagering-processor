import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ApplicationModule } from './application/application.module';
import { HttpModule } from './infrastructure/http/http.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { CorrelationIdMiddleware } from './infrastructure/observability/correlation';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';

@Module({
  imports: [ObservabilityModule, PersistenceModule, ApplicationModule, MessagingModule, HttpModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
