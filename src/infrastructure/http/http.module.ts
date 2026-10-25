import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ApplicationModule } from '../../application/application.module';
import { PROVIDER_IDENTITY } from '../../application/ports';
import { MessagingModule } from '../messaging/messaging.module';
import { NoopProviderIdentity, ProviderAuthGuard } from './auth';
import { HealthController } from './health.controller';
import { HttpExceptionFilter } from './http-exception.filter';
import { RequestLoggingInterceptor } from './request-logging.interceptor';
import { ProvidersController } from './providers.controller';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

@Module({
  imports: [ApplicationModule, MessagingModule],
  controllers: [WalletsController, WageringController, ProvidersController, HealthController],
  providers: [
    // Extension point de autenticação: trocar por um adapter OIDC (Keycloak/Zitadel) sem mexer nos controllers.
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class HttpModule {}
