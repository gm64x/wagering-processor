import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PROVIDER_IDENTITY, type ProviderIdentityPort } from '../../application/ports';

export const IS_PUBLIC_KEY = 'wagering:isPublic';

/** Marca a rota como pública (sem exigir identidade do provedor). Usado pelos endpoints de health. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Implementação atual do ProviderIdentityPort: auth desligada.
 *
 * Ponto de extensão (seção 2 do desafio). Um IdP OIDC (Keycloak ou Zitadel) entra aqui:
 * resolve() validaria o Bearer token (client_credentials) e devolveria o providerId do cliente.
 * Nada além deste provider precisa mudar: o guard abaixo já aplica a regra de vínculo
 * provedor-autenticado x providerId do corpo/rota.
 */
@Injectable()
export class NoopProviderIdentity implements ProviderIdentityPort {
  async resolve(_authorizationHeader: string | undefined): Promise<string | undefined> {
    return undefined;
  }
}

function bodyProviderId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('providerId' in body)) return undefined;
  const value = (body as { providerId: unknown }).providerId;
  return typeof value === 'string' ? value : undefined;
}

function paramProviderId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('providerId' in params)) return undefined;
  const value = (params as { providerId: unknown }).providerId;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Guard global. Rotas @Public() passam direto. Para as demais, consulta PROVIDER_IDENTITY:
 * - sem providerId autenticado (auth desligada): segue;
 * - com providerId autenticado e corpo/rota com outro providerId: 403 PROVIDER_MISMATCH.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const authenticated = await this.identity.resolve(req.headers.authorization);
    if (authenticated === undefined) return true;

    const claimed = [bodyProviderId(req.body), paramProviderId(req.params)];
    if (claimed.some((providerId) => providerId !== undefined && providerId !== authenticated)) {
      throw new HttpException(
        { error: { code: 'PROVIDER_MISMATCH', message: 'providerId does not match the authenticated provider' } },
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
