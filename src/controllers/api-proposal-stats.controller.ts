import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, Req, UseFilters } from '@nestjs/common';
import type { Request } from 'express';
import { ApiResponseUtils } from '../utils/api-response.utils';
import {
  ProposalStatisticsService,
  type StatisticsGranularity,
} from '../modules/notice/proposal-statistics.service';
import { assertValidStatisticsDateRange } from '../utils/request-limits.utils';
import { ApiReadRateLimitService } from '../modules/shared/api-read-rate-limit.service';
import { ApiReadRateLimitFilter } from '../modules/shared/api-read-rate-limit.filter';

@ApiTags('발의 통계')
@Controller('api/stats')
@UseFilters(ApiReadRateLimitFilter)
export class ApiProposalStatsController {
  constructor(
    private readonly proposalStatisticsService: ProposalStatisticsService,
    private readonly apiReadRateLimitService: ApiReadRateLimitService,
  ) {}

  @Get('proposals')
  @ApiQuery({
    name: 'granularity',
    required: false,
    enum: ['daily', 'weekly', 'monthly'],
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    schema: { type: 'string', format: 'date' },
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    schema: { type: 'string', format: 'date' },
  })
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
