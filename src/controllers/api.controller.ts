import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  HttpStatus,
  HttpCode,
  Req,
  Res,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { WebhookService } from '../modules/webhook/webhook.service';
import { CrawlingService } from '../modules/crawling/crawling.service';
import { HealthCheckService } from '../modules/health/health-check.service';
import { BatchProcessingService } from '../modules/shared/batch-processing.service';
import { NoticeArchiveService } from '../modules/notice/notice-archive.service';
import { NoticesQueryService } from '../modules/crawling/notices-query.service';
import { NoticeSearchService } from '../modules/crawling/notice-search.service';
import { CreateWebhookDto } from '../modules/webhook/dto/create-webhook.dto';
import { ApiResponseUtils } from '../utils/api-response.utils';
import { APP_CONSTANTS } from '../config/app.config';
import { RuntimeStatsService } from '../modules/health/runtime-stats.service';
import { ArchiveSyncService } from '../modules/crawling/archive-sync.service';
import { PackagesService } from '../modules/shared/packages.service';
import { ChangeTrackingService } from '../modules/change-tracking/change-tracking.service';
import { type ChangeEventType } from '../modules/change-tracking/notice-change-event.entity';
import { WebhookRegistrationService } from '../modules/notification/webhook-registration.service';

@Controller('api')
export class ApiController {
  constructor(
    private readonly configService: ConfigService,
    private readonly webhookRegistrationService: WebhookRegistrationService,
    private readonly webhookService: WebhookService,
    private readonly crawlingService: CrawlingService,
    private readonly healthCheckService: HealthCheckService,
    private readonly batchProcessingService: BatchProcessingService,
    private readonly noticeArchiveService: NoticeArchiveService,
    private readonly noticesQueryService: NoticesQueryService,
    private readonly noticeSearchService: NoticeSearchService,
    private readonly runtimeStatsService: RuntimeStatsService,
    private readonly archiveSyncService: ArchiveSyncService,
    private readonly packagesService: PackagesService,
    private readonly changeTrackingService: ChangeTrackingService,
  ) {}

  @Post('webhooks')
  @HttpCode(HttpStatus.CREATED)
  async createWebhook(
    @Body() createWebhookDto: CreateWebhookDto,
    @Req() req: Request,
  ) {
    return this.webhookRegistrationService.registerWebhook(
      createWebhookDto,
      req,
    );
  }

  @Get('notices/recent')
  async getRecentNotices() {
    const notices = await this.crawlingService.getRecentNotices(
      APP_CONSTANTS.CACHE.NOTICES_RECENT_LIMIT,
    );
    return ApiResponseUtils.success(notices);
  }

  @Get('notices/keywords')
  async getQuickKeywordSuggestions(
    @Query('limit', new DefaultValuePipe(8), ParseIntPipe) limit: number,
  ) {
    const suggestions =
      await this.crawlingService.getQuickKeywordSuggestions(limit);
    return ApiResponseUtils.success(suggestions);
  }

  @Get('notices/archive')
  async getArchivedNotices(
    @Query(
      'page',
      new DefaultValuePipe(APP_CONSTANTS.API.PAGINATION.MIN_PAGE),
      ParseIntPipe,
    )
    page: number,
    @Query(
      'limit',
      new DefaultValuePipe(APP_CONSTANTS.API.PAGINATION.DEFAULT_LIMIT),
      ParseIntPipe,
    )
    limit: number,
    @Query('search') search?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('sortOrder') sortOrder?: string,
    @Query('isDone') isDoneRaw?: string,
    @Query('fullText') fullTextRaw?: string,
  ) {
    const isDone =
      isDoneRaw === 'true' ? true : isDoneRaw === 'false' ? false : undefined;
    const fullText = fullTextRaw === 'true';
    const archiveResult = await this.noticesQueryService.getArchivedNotices({
      page,
      limit,
      search,
      startDate,
      endDate,
      sortOrder: sortOrder === 'asc' ? 'asc' : 'desc',
      isDone,
      fullText,
    });
    return ApiResponseUtils.success(archiveResult);
  }

  @Get('notices/search')
  async searchNotices(
    @Query('q') q: string,
    @Query(
      'page',
      new DefaultValuePipe(APP_CONSTANTS.API.PAGINATION.MIN_PAGE),
      ParseIntPipe,
    )
    page: number,
    @Query(
      'limit',
      new DefaultValuePipe(APP_CONSTANTS.API.PAGINATION.DEFAULT_LIMIT),
      ParseIntPipe,
    )
    limit: number,
    @Query('includeDone') includeDoneRaw?: string,
  ) {
    const keyword = (q || '').trim();
    if (!keyword) {
      return ApiResponseUtils.success({
        items: [],
        total: 0,
        page,
        limit,
        totalPages: 1,
        keyword: '',
        source: 'archive',
      });
    }
    const includeDone = includeDoneRaw !== 'false';
    const result = await this.noticeSearchService.searchNotices({
      keyword,
      page,
      limit,
      includeDone,
    });
    return ApiResponseUtils.success(result);
  }

  @Get('notices/:num/detail')
  async getNoticeDetail(
    @Param('num', ParseIntPipe) num: number,
    @Query('rev') revRaw?: string,
  ) {
    const { detail, revision } =
      await this.noticeArchiveService.getArchivedNoticeDetailWithRevision(
        num,
        revRaw,
      );

    return ApiResponseUtils.success({
      ...detail,
      aiSummaryEnabled: (await this.healthCheckService.getOllamaMetrics())
        .enabled,
      revision,
    });
  }

  @Get('notices/:num/changes')
  async getNoticeChanges(
    @Param('num', ParseIntPipe) num: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const timeline = await this.changeTrackingService.getNoticeChangeTimeline({
      noticeNum: num,
      limit,
    });

    return ApiResponseUtils.success({
      noticeNum: num,
      items: timeline,
      count: timeline.length,
    });
  }

  @Get('notices/changes')
  async getRecentNoticeChanges(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('eventType') eventTypeRaw?: string,
    @Query('excludeLegacyGenesisSource') excludeLegacyGenesisSourceRaw?: string,
    @Query('comparableOnly') comparableOnlyRaw?: string,
  ) {
    const allowedEventTypes: ChangeEventType[] = [
      'created',
      'updated',
      'redacted',
      'invalidated',
    ];

    const eventType = allowedEventTypes.includes(
      eventTypeRaw as ChangeEventType,
    )
      ? (eventTypeRaw as ChangeEventType)
      : undefined;

    const excludeLegacyGenesisSource = excludeLegacyGenesisSourceRaw === 'true';
    const comparableOnly = comparableOnlyRaw === 'true';

    const result = await this.changeTrackingService.getRecentChanges({
      page,
      limit,
      eventType,
      excludeLegacyGenesisSource,
      comparableOnly,
    });

    return ApiResponseUtils.success(result);
  }

  @Get('notices/changes/summary')
  async getComparableNoticeChangesSummary() {
    const summary =
      await this.changeTrackingService.getComparableChangeSummary();
    return ApiResponseUtils.success(summary);
  }

  @Get('notices/:num/screenshot')
  async getNoticeScreenshot(
    @Param('num', ParseIntPipe) num: number,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result =
      await this.noticeArchiveService.getScreenshotByNoticeNum(num);

    if (!result) {
      throw new NotFoundException(
        `의안번호 ${num}에 해당하는 스크린샷을 찾을 수 없습니다.`,
      );
    }

    const mimeType = result.format === 'png' ? 'image/png' : 'image/jpeg';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return new StreamableFile(result.blob);
  }

  @Get('notices/:num/export')
  async exportNoticeArchive(
    @Param('num', ParseIntPipe) num: number,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.noticeArchiveService.buildArchiveExportZip(num);

    if (!result) {
      throw new NotFoundException(`Archive not found for notice ${num}`);
    }

    const { zipBuffer, zipFileName } = result;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${zipFileName}"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(zipBuffer);
  }

  @Get('stats')
  async getStats() {
    const nodeEnv = this.configService.get<string>('nodeEnv');
    const stats = await this.runtimeStatsService.getAggregatedStats(
      { nodeEnv },
      this.webhookService,
      this.crawlingService,
      this.batchProcessingService,
      this.noticeArchiveService,
      this.archiveSyncService,
      this.changeTrackingService,
    );
    return ApiResponseUtils.success(stats);
  }

  @Get('batch/status')
  async getBatchStatus() {
    const status = await this.batchProcessingService.getBatchStatusForApi({
      nodeEnv: this.configService.get<string>('nodeEnv'),
    });
    return ApiResponseUtils.success(
      status,
      'Batch processing status retrieved successfully',
    );
  }

  @Get('health')
  async getHealth() {
    const healthPayload = await this.crawlingService.getApiHealthPayload({
      nodeEnv: this.configService.get<string>('nodeEnv'),
    });
    return ApiResponseUtils.success(healthPayload, 'LawCast API is healthy');
  }

  @Get('webhooks/stats/detailed')
  async getDetailedWebhookStats() {
    const stats = await this.webhookService.getDetailedStatsForApi({
      nodeEnv: this.configService.get<string>('nodeEnv'),
    });
    return ApiResponseUtils.success(
      stats,
      'Detailed webhook statistics retrieved successfully',
    );
  }

  @Get('webhooks/system-health')
  async getSystemHealth() {
    const systemHealth = await this.webhookService.getSystemHealthForApi({
      nodeEnv: this.configService.get<string>('nodeEnv'),
    });
    return ApiResponseUtils.success(
      systemHealth,
      'System health status retrieved successfully',
    );
  }

  @Get('redis/status')
  async getRedisStatus() {
    const redisStatusPayload = await this.crawlingService.getRedisStatusForApi({
      nodeEnv: this.configService.get<string>('nodeEnv'),
    });
    return ApiResponseUtils.success(
      redisStatusPayload.data,
      redisStatusPayload.message,
    );
  }

  @Get('redis/connection')
  async checkRedisConnection() {
    const isConnected = await this.crawlingService.isRedisConnected();

    return ApiResponseUtils.success(
      {
        connected: isConnected,
        timestamp: new Date().toISOString(),
      },
      isConnected ? 'Redis is connected' : 'Redis connection failed',
    );
  }

  @Get('packages')
  getPackages() {
    return ApiResponseUtils.success(this.packagesService.getPackages());
  }
}
