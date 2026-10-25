import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { LedgerPage, ReconciliationReport, WalletView } from '../../application/dto';
import { WalletService } from '../../application/wallet.service';
import { currentCorrelationId } from '../observability/correlation';
import {
  parseCreateWalletBody,
  parseLimit,
  parseOptionalCursor,
  requireUuid,
} from './validation';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletService) {}

  /** 201 com WalletView. Saldo inicial > 0 gera OPENING na mesma transação SQL (feito pelo WalletService). */
  @Post()
  async create(@Body() body: unknown): Promise<WalletView> {
    const { playerId, initialBalance } = parseCreateWalletBody(body);
    return this.wallets.create({ playerId, initialBalance, correlationId: currentCorrelationId() ?? uuidv7() });
  }

  @Get(':walletId')
  async get(@Param() params: Record<string, unknown>): Promise<WalletView> {
    return this.wallets.get(requireUuid(params, 'walletId'));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param() params: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ): Promise<LedgerPage> {
    const walletId = requireUuid(params, 'walletId');
    return this.wallets.ledger(walletId, parseOptionalCursor(query.cursor), parseLimit(query.limit));
  }

  /** 200 sempre que a reconciliação roda; divergência aparece em consistent=false (e em log/métrica). */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param() params: Record<string, unknown>): Promise<ReconciliationReport> {
    const walletId = requireUuid(params, 'walletId');
    return this.wallets.reconcile(walletId, currentCorrelationId() ?? uuidv7());
  }
}
