import { Module } from '@nestjs/common';
import { CacheInfraModule } from '../cache/cache.module';
import { NoticeModule } from '../notice/notice.module';
import { NotificationModule } from '../notification/notification.module';
import { HealthModule } from '../health/health.module';
import { OllamaModule } from '../ollama/ollama.module';
import { DiscordBridgeModule } from '../discord-bridge/discord-bridge.module';
import { ChangeTrackingModule } from '../change-tracking/change-tracking.module';
import { CrawlingCoreService } from './crawling-core.service';
import { SummaryGenerationService } from './summary-generation.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { ArchiveSyncService } from './archive-sync.service';
import { CrawlingSchedulerService } from './crawling-scheduler.service';
import { CrawlingService } from './crawling.service';
import { NoticesQueryService } from './notices-query.service';
import { NoticeSearchService } from './notice-search.service';

@Module({
  imports: [
    CacheInfraModule,
    NoticeModule,
    NotificationModule,
    HealthModule,
    OllamaModule,
    DiscordBridgeModule,
    ChangeTrackingModule,
  ],
  providers: [
    CrawlingCoreService,
    SummaryGenerationService,
    ArchiveOrchestratorService,
    ArchiveSyncService,
    CrawlingSchedulerService,
    CrawlingService,
    NoticesQueryService,
    NoticeSearchService,
  ],
  exports: [
    CrawlingCoreService,
    CrawlingService,
    CrawlingSchedulerService,
    ArchiveOrchestratorService,
    ArchiveSyncService,
    NoticesQueryService,
    NoticeSearchService,
  ],
})
export class CrawlingModule {}
