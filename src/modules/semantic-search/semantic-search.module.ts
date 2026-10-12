import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { CrawlingModule } from '../crawling/crawling.module';
import { NoticeModule } from '../notice/notice.module';
import { ChangeTrackingModule } from '../change-tracking/change-tracking.module';
import { SemanticSearchController } from './semantic-search.controller';
import { SemanticSearchService } from './semantic-search.service';
import { NoticesHybridSearchService } from './notices-hybrid-search.service';

/**
 * Semantic search feature: proxies the Python sidecar and degrades to the
 * existing keyword search. SharedModule provides the API read rate limiter,
 * CrawlingModule the keyword NoticesQueryService/NoticeSearchService, and
 * NoticeModule + ChangeTrackingModule the archive hydration the board's
 * hybrid search mode needs.
 */
@Module({
  imports: [SharedModule, CrawlingModule, NoticeModule, ChangeTrackingModule],
  controllers: [SemanticSearchController],
  providers: [SemanticSearchService, NoticesHybridSearchService],
  exports: [SemanticSearchService, NoticesHybridSearchService],
})
export class SemanticSearchModule {}
