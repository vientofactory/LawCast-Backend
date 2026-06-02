import { Module } from '@nestjs/common';
import { CacheInfraModule } from '../cache/cache.module';
import { OllamaModule } from '../ollama/ollama.module';
import { HealthCheckService } from './health-check.service';
import { RuntimeStatsService } from './runtime-stats.service';

@Module({
  imports: [CacheInfraModule, OllamaModule],
  providers: [HealthCheckService, RuntimeStatsService],
  exports: [HealthCheckService, RuntimeStatsService],
})
export class HealthModule {}
