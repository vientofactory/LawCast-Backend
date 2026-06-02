import { Module } from '@nestjs/common';
import { BatchProcessingService } from './batch-processing.service';
import { HashguardService } from './hashguard.service';

@Module({
  providers: [BatchProcessingService, HashguardService],
  exports: [BatchProcessingService, HashguardService],
})
export class SharedModule {}
