import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { date, int, query, str, type Row } from './sql';

const COLUMNS = 'id, player_id, currency, balance_amount, version, created_at, updated_at';

/** Violação do controle de versão (outro writer alterou a wallet sem segurar o lock). Não deve ocorrer sob FOR UPDATE. */
export class WalletVersionConflictError extends Error {
  constructor(walletId: string, expectedVersion: number) {
    super(`wallet ${walletId} was modified concurrently (expected version ${expectedVersion})`);
    this.name = 'WalletVersionConflictError';
  }
}

function toWallet(row: Row): Wallet {
  const currency = str(row, 'currency');
  return Wallet.rehydrate({
    id: str(row, 'id'),
    playerId: str(row, 'player_id'),
    currency,
    balance: Money.fromPersisted(str(row, 'balance_amount'), currency),
    version: int(row, 'version'),
    createdAt: date(row, 'created_at'),
    updatedAt: date(row, 'updated_at'),
  });
}

/** Todas as operações recebem o EntityManager TRANSACIONAL da chamada: o repositório não abre transação. */
@Injectable()
export class WalletRepository {
  /**
   * Lock pessimista de linha: a wallet é a unidade de concorrência. Quem chega depois espera o commit/rollback
   * do anterior e, em READ COMMITTED, já enxerga o saldo comitado (a linha é relida após o lock).
   */
  async lockById(em: EntityManager, id: string): Promise<Wallet | null> {
    const rows = await query(em, `SELECT ${COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`, [id]);
    const row = rows[0];
    return row ? toWallet(row) : null;
  }

  async findById(em: EntityManager, id: string): Promise<Wallet | null> {
    const rows = await query(em, `SELECT ${COLUMNS} FROM wallets WHERE id = ?`, [id]);
    const row = rows[0];
    return row ? toWallet(row) : null;
  }

  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    const s = wallet.toState();
    await query(
      em,
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [s.id, s.playerId, s.currency, s.balance.amount, s.version, s.createdAt, s.updatedAt],
    );
  }

  /**
   * Persiste o novo saldo/versão da wallet já movimentada. `WHERE version = ?` é a segunda barreira
   * (a primeira é o FOR UPDATE): exatamente 1 linha deve ser afetada, senão alguém escreveu sem o lock.
   */
  async updateBalance(em: EntityManager, wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await query(
      em,
      `UPDATE wallets SET balance_amount = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ? RETURNING id`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (rows.length !== 1) {
      throw new WalletVersionConflictError(wallet.id, expectedVersion);
    }
  }
}
