import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './mikro-orm.config';
import { WalletRepository } from './wallet.repository';
import { WagerTransactionRepository } from './wager-transaction.repository';
import { LedgerRepository } from './ledger.repository';
import { InboxRepository } from './inbox.repository';
import { OutboxRepository } from './outbox.repository';

const REPOSITORIES = [WalletRepository, WagerTransactionRepository, LedgerRepository, InboxRepository, OutboxRepository];

// MikroOrmCoreModule (de forRoot) é @Global: MikroORM / EntityManager ficam injetáveis em qualquer módulo (ex.: health check).
@Module({
  imports: [
    // registerRequestContext:false — nenhum EntityManager "ambiente": cada caso de uso faz
    // `orm.em.fork().transactional(...)` e passa o EM transacional explicitamente aos repositórios.
    MikroOrmModule.forRoot({ ...config, registerRequestContext: false }),
  ],
  providers: REPOSITORIES,
  exports: REPOSITORIES,
})
export class PersistenceModule {}
