import { Module } from '@nestjs/common';
import { BatchProcessingService } from './batch-processing.service';
import { HashguardService } from './hashguard.service';
import { PackagesService } from './packages.service';
import { SqliteRuntimeTuningService } from './sqlite-runtime-tuning.service';
import { ApiReadRateLimitService } from './api-read-rate-limit.service';
import { CacheInfraModule } from '../cache/cache.module';

@Module({
  imports: [CacheInfraModule],
  providers: [
    BatchProcessingService,
    HashguardService,
    PackagesService,
    SqliteRuntimeTuningService,
    ApiReadRateLimitService,
  ],
  exports: [
    BatchProcessingService,
    HashguardService,
    PackagesService,
    ApiReadRateLimitService,
  ],
})
export class SharedModule {}
