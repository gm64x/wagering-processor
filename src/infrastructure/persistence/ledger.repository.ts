import { Injectable } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { date, int, optStr, query, str, type Row } from './sql';

export interface LedgerRecord {
  /** posição estável no ledger (bigserial); base do cursor de paginação */
  seq: string;
  entry: WalletLedgerEntry;
}

export interface ReconciliationSnapshot {
  currency: string;
  storedBalance: Money;
  calculatedBalance: Money;
  entries: number;
  /** balance_after do último lançamento (por seq); undefined se não há lançamentos */
  lastBalanceAfter: Money | undefined;
}

function toRecord(row: Row): LedgerRecord {
  const currency = str(row, 'currency');
  return {
    seq: String(row.seq),
    entry: WalletLedgerEntry.rehydrate({
      id: str(row, 'id'),
      walletId: str(row, 'wallet_id'),
      transactionId: str(row, 'transaction_id'),
      direction: str(row, 'direction') as LedgerDirection,
      money: Money.fromPersisted(str(row, 'amount'), currency),
      balanceBefore: Money.fromPersisted(str(row, 'balance_before_amount'), currency),
      balanceAfter: Money.fromPersisted(str(row, 'balance_after_amount'), currency),
      createdAt: date(row, 'created_at'),
    }),
  };
}

/** Ledger append-only: só existe INSERT e leitura (o schema também bloqueia UPDATE/DELETE por trigger). */
@Injectable()
export class LedgerRepository {
  async insert(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    await query(
      em,
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before_amount, balance_after_amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      [
        entry.id, entry.walletId, entry.transactionId, entry.direction, entry.money.amount, entry.money.currency,
        entry.balanceBefore.amount, entry.balanceAfter.amount, entry.createdAt,
      ],
    );
  }

  /** Página ordenada por seq ASC, estritamente depois de `afterSeq`. seq é validado como dígitos pelo chamador. */
  async pageByWallet(em: EntityManager, walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerRecord[]> {
    const rows = await query(
      em,
      `SELECT seq, id, wallet_id, transaction_id, direction, amount, currency,
              balance_before_amount, balance_after_amount, created_at
       FROM wallet_ledger_entries
       WHERE wallet_id = ? AND seq > ?::bigint
       ORDER BY seq ASC LIMIT ?`,
      [walletId, afterSeq ?? '0', limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Saldo armazenado x saldo reconstruído pelo ledger, num ÚNICO statement (um snapshot): ler a wallet e somar o
   * ledger em dois statements poderia atravessar um commit concorrente e acusar divergência falsa.
   */
  async reconciliationSnapshot(em: EntityManager, walletId: string): Promise<ReconciliationSnapshot | null> {
    const rows = await query(
      em,
      `SELECT w.currency, w.balance_amount,
         COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS calculated_amount,
         COUNT(l.id) AS entries,
         (SELECT x.balance_after_amount FROM wallet_ledger_entries x WHERE x.wallet_id = w.id ORDER BY x.seq DESC LIMIT 1) AS last_after
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return null;
    const currency = str(row, 'currency');
    const lastAfter = optStr(row, 'last_after');
    return {
      currency,
      storedBalance: Money.fromPersisted(str(row, 'balance_amount'), currency),
      calculatedBalance: Money.fromPersisted(str(row, 'calculated_amount'), currency),
      entries: int(row, 'entries'),
      lastBalanceAfter: lastAfter === undefined ? undefined : Money.fromPersisted(lastAfter, currency),
    };
  }
}
