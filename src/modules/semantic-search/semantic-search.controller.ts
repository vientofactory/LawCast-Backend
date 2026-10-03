import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseFilters,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiReadRateLimitFilter } from '../shared/api-read-rate-limit.filter';
import { ApiReadRateLimitService } from '../shared/api-read-rate-limit.service';
import { ApiResponseUtils } from '../../utils/api-response.utils';
import { assertSearchLength } from '../../utils/request-limits.utils';
import { DEFAULT_K, MAX_K } from './semantic-search.constants';
import { SemanticSearchService } from './semantic-search.service';

/**
 * Semantic search endpoint. Separate from the keyword search route on
 * purpose: the existing notice search API is untouched and this endpoint can
 * degrade independently (keyword fallback) when the engine is unavailable.
 */
@Controller('api')
@UseFilters(ApiReadRateLimitFilter)
export class SemanticSearchController {
  constructor(
    private readonly semanticSearchService: SemanticSearchService,
    private readonly apiReadRateLimitService: ApiReadRateLimitService,
  ) {}

  @Get('notices/semantic-search')
  async semanticSearch(
    @Req() req: Request,
    @Query('query') queryRaw?: string,
    @Query('k') kRaw?: string,
  ) {
    await this.apiReadRateLimitService.assertAllowed(req, 'expensive');

    const query = (queryRaw || '').trim();
    if (!query) {
      throw new BadRequestException('query 파라미터가 필요합니다.');
    }
    assertSearchLength(query);

    const k = this.parseK(kRaw);
    const result = await this.semanticSearchService.searchSemantic(query, k);
    return ApiResponseUtils.success(result);
  }

  /**
   * Engine status proxy for the frontend semantic search status block: the sidecar
   * is reachable only from the backend, so its `/health` fields
   * (indexedChunks, lastUpdateAt, lastUpdateTriggeredAt) pass through here.
   * Failures surface as 503 (no keyword-style fallback applies to status).
   */
  @Get('notices/semantic-search/health')
  async engineHealth(@Req() req: Request) {
    await this.apiReadRateLimitService.assertAllowed(req);

    const health = await this.semanticSearchService.getEngineHealth();
    return ApiResponseUtils.success(health);
  }

  /**
   * Strict k parsing, scoped to this endpoint on purpose. The shared
   * `parsePositiveInteger` uses parseInt and would silently accept `3.9` as
   * 3 or `1e2` as 1, hiding client bugs; here only plain positive integers
   * within range pass. Other endpoints keep the lenient shared util
   * unchanged.
   */
  private parseK(raw?: string): number {
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') {
      return DEFAULT_K;
    }
    const invalid = () =>
      new BadRequestException(`k는 1에서 ${MAX_K} 사이의 정수여야 합니다.`);
    if (!/^[0-9]+$/.test(trimmed)) {
      throw invalid();
    }
    const parsed = Number(trimmed);
    if (parsed < 1 || parsed > MAX_K) {
      throw invalid();
    }
    return parsed;
  }
}
