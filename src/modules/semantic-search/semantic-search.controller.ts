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
import { parsePositiveInteger } from '../../utils/query-parsing.utils';
import { SemanticSearchService } from './semantic-search.service';

const DEFAULT_K = 5;
const MAX_K = 50;

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

  private parseK(raw?: string): number {
    if (raw === undefined || raw.trim() === '') {
      return DEFAULT_K;
    }
    const parsed = parsePositiveInteger(raw);
    if (parsed === undefined || parsed > MAX_K) {
      throw new BadRequestException(
        `k는 1에서 ${MAX_K} 사이의 정수여야 합니다.`,
      );
    }
    return parsed;
  }
}
