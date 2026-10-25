import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import type { WagerTransactionResult, WagerTransactionView } from '../../application/dto';
import { WageringService } from '../../application/wagering.service';
import { currentCorrelationId } from '../observability/correlation';
import { submitStatusCode } from './http-status';
import { parseIdempotencyKey, parseSubmitWagerTransactionBody, requireUuid } from './validation';

@Controller('wagering')
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  /**
   * Submete uma transação. Idempotency-Key é obrigatório (fonte da verdade da idempotência).
   * O status HTTP vem do resultado: 201 novo, 200 replay, 202 PENDING_REFERENCE, 422 REJECTED, 500 FAILED.
   */
  @Post('transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerTransactionResult> {
    const key = parseIdempotencyKey(idempotencyKey);
    const fields = parseSubmitWagerTransactionBody(body);
    const result = await this.wagering.submit({
      ...fields,
      idempotencyKey: key,
      correlationId: currentCorrelationId() ?? uuidv7(),
    });
    res.status(submitStatusCode(result));
    return result;
  }

  @Get('transactions/:transactionId')
  async getTransaction(@Param() params: Record<string, unknown>): Promise<WagerTransactionView> {
    return this.wagering.getById(requireUuid(params, 'transactionId'));
  }
}
