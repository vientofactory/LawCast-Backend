import { Module } from '@nestjs/common';
import { BatchProcessingService } from './batch-processing.service';
import { HashguardService } from './hashguard.service';
import { PackagesService } from './packages.service';

@Module({
  providers: [BatchProcessingService, HashguardService, PackagesService],
  exports: [BatchProcessingService, HashguardService, PackagesService],
})
export class SharedModule {}
