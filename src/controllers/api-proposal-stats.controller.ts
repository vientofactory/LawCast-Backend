import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiResponseUtils } from '../utils/api-response.utils';
import {
  ProposalStatisticsService,
  type StatisticsGranularity,
} from '../modules/notice/proposal-statistics.service';
import { assertValidStatisticsDateRange } from '../utils/request-limits.utils';
import { ApiReadRateLimitService } from '../modules/shared/api-read-rate-limit.service';

@Controller('api/stats')
export class ApiProposalStatsController {
  constructor(
    private readonly proposalStatisticsService: ProposalStatisticsService,
    private readonly apiReadRateLimitService: ApiReadRateLimitService,
  ) {}

  @Get('proposals')
  async getProposalStatistics(
    @Req() req: Request,
    @Query('granularity') granularityRaw?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    assertValidStatisticsDateRange(startDate, endDate);
    await this.apiReadRateLimitService.assertAllowed(req, 'expensive');
    const allowedGranularities: StatisticsGranularity[] = [
      'daily',
      'weekly',
      'monthly',
    ];
    const granularity: StatisticsGranularity = allowedGranularities.includes(
      granularityRaw as StatisticsGranularity,
    )
      ? (granularityRaw as StatisticsGranularity)
      : 'daily';

    const result = await this.proposalStatisticsService.getProposalStatistics({
      granularity,
      startDate,
      endDate,
    });

    return ApiResponseUtils.success(result);
  }
}
