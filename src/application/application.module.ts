import { Module } from '@nestjs/common';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { PendingReferenceWorker } from './pending-reference.worker';
import { WagerEngine } from './wager-engine';
import { WageringService } from './wagering.service';
import { WalletService } from './wallet.service';

@Module({
  imports: [PersistenceModule],
  providers: [WagerEngine, WageringService, WalletService, PendingReferenceWorker],
  exports: [WageringService, WalletService, PendingReferenceWorker],
})
export class ApplicationModule {}
