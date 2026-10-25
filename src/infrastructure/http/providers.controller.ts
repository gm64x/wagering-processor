import { Controller, Get, Param } from '@nestjs/common';
import type { WagerTransactionView } from '../../application/dto';
import { WageringService } from '../../application/wagering.service';
import { LIMITS, requireString } from './validation';

@Controller('providers')
export class ProvidersController {
  constructor(private readonly wagering: WageringService) {}

  /** Consulta pelo id externo do provedor (a chave que o provedor conhece). */
  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async getByExternal(@Param() params: Record<string, unknown>): Promise<WagerTransactionView> {
    const providerId = requireString(params, 'providerId', { max: LIMITS.providerId });
    const externalTransactionId = requireString(params, 'externalTransactionId', { max: LIMITS.externalId });
    return this.wagering.getByExternal(providerId, externalTransactionId);
  }
}
