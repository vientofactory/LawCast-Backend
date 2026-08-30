import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheInfraModule } from '../cache/cache.module';
import { OllamaModule } from '../ollama/ollama.module';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { NoticeChangeEvent } from '../change-tracking/notice-change-event.entity';
import { HealthCheckService } from './health-check.service';
import { RuntimeStatsService } from './runtime-stats.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([NoticeArchive, NoticeChangeEvent]),
    CacheInfraModule,
    OllamaModule,
  ],
  providers: [HealthCheckService, RuntimeStatsService],
  exports: [HealthCheckService, RuntimeStatsService],
})
export class HealthModule {}
