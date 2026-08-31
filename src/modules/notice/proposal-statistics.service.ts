import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Repository } from 'typeorm';
import { NoticeArchive } from './notice-archive.entity';

export type StatisticsGranularity = 'daily' | 'weekly' | 'monthly';

export interface ProposalStatisticsQuery {
  granularity: StatisticsGranularity;
  startDate?: string;
  endDate?: string;
}

export interface ProposalStatisticsBucket {
  period: string;
  count: number;
}

export interface ProposalStatisticsResult {
  granularity: StatisticsGranularity;
  startDate: string | null;
  endDate: string | null;
  totalCount: number;
  buckets: ProposalStatisticsBucket[];
}

@Injectable()
export class ProposalStatisticsService {
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    @InjectRepository(NoticeArchive)
    private readonly archiveRepository: Repository<NoticeArchive>,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  private buildCacheKey(query: ProposalStatisticsQuery): string {
    return `proposal-stats:${query.granularity}:${query.startDate ?? ''}:${query.endDate ?? ''}`;
  }

  async getProposalStatistics(
    query: ProposalStatisticsQuery,
  ): Promise<ProposalStatisticsResult> {
    const cacheKey = this.buildCacheKey(query);
    const cached =
      await this.cacheManager.get<ProposalStatisticsResult>(cacheKey);
    if (cached) return cached;

    const { granularity, startDate, endDate } = query;

    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    const qb = this.archiveRepository
      .createQueryBuilder('archive')
      .select('COUNT(*)', 'count');

    const dateExpr = this.getDateExpression(granularity);
    qb.addSelect(dateExpr, 'period');

    if (start && !Number.isNaN(start.getTime())) {
      qb.andWhere('archive.archive_started_at >= :startDate', {
        startDate: start,
      });
    }

    if (end && !Number.isNaN(end.getTime())) {
      qb.andWhere('archive.archive_started_at <= :endDate', {
        endDate: end,
      });
    }

    qb.groupBy('period').orderBy('period', 'ASC');

    const rows = await qb.getRawMany<{ period: string; count: string }>();

    const totalCount = rows.reduce((sum, row) => sum + Number(row.count), 0);

    const buckets: ProposalStatisticsBucket[] = rows.map((row) => ({
      period: this.normalizePeriod(row.period, granularity),
      count: Number(row.count),
    }));

    const result: ProposalStatisticsResult = {
      granularity,
      startDate:
        start && !Number.isNaN(start.getTime()) ? start.toISOString() : null,
      endDate: end && !Number.isNaN(end.getTime()) ? end.toISOString() : null,
      totalCount,
      buckets,
    };

    await this.cacheManager.set(
      cacheKey,
      result,
      ProposalStatisticsService.CACHE_TTL_MS,
    );

    return result;
  }

  /**
   * Returns SQLite date-formatting expression for the given granularity.
   */
  private getDateExpression(granularity: StatisticsGranularity): string {
    switch (granularity) {
      case 'daily':
        // YYYY-MM-DD
        return "strftime('%Y-%m-%d', archive.archive_started_at, 'localtime')";
      case 'weekly':
        // ISO week: YYYY-Wxx (start of ISO week, Sunday-based for SQLite)
        return "strftime('%Y-W%W', archive.archive_started_at, 'localtime', 'weekday 1', '-6 days')";
      case 'monthly':
        // YYYY-MM
        return "strftime('%Y-%m', archive.archive_started_at, 'localtime')";
      default:
        return "strftime('%Y-%m-%d', archive.archive_started_at, 'localtime')";
    }
  }

  /**
   * Normalizes the period string from SQLite strftime output.
   */
  private normalizePeriod(
    rawPeriod: string,
    granularity: StatisticsGranularity,
  ): string {
    if (granularity === 'weekly') {
      // Convert YYYY-Wxx to YYYY-Wxx format (already in this format from strftime)
      return rawPeriod;
    }
    return rawPeriod;
  }
}
