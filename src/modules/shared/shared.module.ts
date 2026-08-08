import { Module } from '@nestjs/common';
import { BatchProcessingService } from './batch-processing.service';
import { HashguardService } from './hashguard.service';
import { PackagesService } from './packages.service';
import { SqliteRuntimeTuningService } from './sqlite-runtime-tuning.service';

@Module({
  providers: [
    BatchProcessingService,
    HashguardService,
    PackagesService,
    SqliteRuntimeTuningService,
  ],
  exports: [BatchProcessingService, HashguardService, PackagesService],
})
export class SharedModule {}
