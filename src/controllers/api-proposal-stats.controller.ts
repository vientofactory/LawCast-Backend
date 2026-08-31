import { Controller, Get, Query } from '@nestjs/common';
import { ApiResponseUtils } from '../utils/api-response.utils';
import {
  ProposalStatisticsService,
  type StatisticsGranularity,
} from '../modules/notice/proposal-statistics.service';

@Controller('api/stats')
export class ApiProposalStatsController {
  constructor(
    private readonly proposalStatisticsService: ProposalStatisticsService,
  ) {}

  @Get('proposals')
  async getProposalStatistics(
    @Query('granularity') granularityRaw?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
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
