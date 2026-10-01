import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { CrawlingModule } from '../crawling/crawling.module';
import { SemanticSearchController } from './semantic-search.controller';
import { SemanticSearchService } from './semantic-search.service';

/**
 * Semantic search feature: proxies the Python sidecar and degrades to the
 * existing keyword search. SharedModule provides the API read rate limiter,
 * CrawlingModule the keyword NoticeSearchService used for the fallback.
 */
@Module({
  imports: [SharedModule, CrawlingModule],
  controllers: [SemanticSearchController],
  providers: [SemanticSearchService],
  exports: [SemanticSearchService],
})
export class SemanticSearchModule {}
