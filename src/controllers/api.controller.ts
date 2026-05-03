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
import { WebhookService } from '../services/webhook.service';
import { CrawlingService } from '../services/crawling.service';
import { HealthCheckService } from '../services/health-check.service';
import { NotificationService } from '../services/notification.service';
import { HashguardService } from '../services/hashguard.service';
import { BatchProcessingService } from '../services/batch-processing.service';
import { NoticeArchiveService } from '../services/notice-archive.service';
import { NoticesQueryService } from '../services/notices-query.service';
import { NoticeSearchService } from '../services/notice-search.service';
import { CreateWebhookDto } from '../dto/create-webhook.dto';
import { WebhookValidationUtils } from '../utils/webhook-validation.utils';
import { ApiResponseUtils, ErrorContext } from '../utils/api-response.utils';
import { APP_CONSTANTS } from '../config/app.config';
import { RuntimeStatsService } from '../services/runtime-stats.service';
import { IsDoneSyncService } from '../services/is-done-sync.service';

@Controller('api')
export class ApiController {
  constructor(
    private readonly configService: ConfigService,
    private readonly webhookService: WebhookService,
    private readonly crawlingService: CrawlingService,
    private readonly healthCheckService: HealthCheckService,
    private readonly notificationService: NotificationService,
    private readonly hashguardService: HashguardService,
    private readonly batchProcessingService: BatchProcessingService,
    private readonly noticeArchiveService: NoticeArchiveService,
    private readonly noticesQueryService: NoticesQueryService,
    private readonly noticeSearchService: NoticeSearchService,
    private readonly runtimeStatsService: RuntimeStatsService,
    private readonly isDoneSyncService: IsDoneSyncService,
  ) {}

  @Post('webhooks')
  @HttpCode(HttpStatus.CREATED)
  async createWebhook(
    @Body() createWebhookDto: CreateWebhookDto,
    @Req() req: Request,
  ) {
    try {
      // URL 유효성 검증
      WebhookValidationUtils.validateDiscordWebhookUrl(createWebhookDto.url);

      // PoW 검증
      const clientIp = WebhookValidationUtils.extractClientIp(req);
      const isProofValid = await this.hashguardService.verifyProof(
        createWebhookDto.proof,
        clientIp,
      );

      if (!isProofValid) {
        throw ApiResponseUtils.createPoWFailedException();
      }

      // 중복 웹훅 URL 체크
      const existingWebhook = await this.webhookService.findByUrl(
        createWebhookDto.url,
      );
      if (existingWebhook) {
        throw ApiResponseUtils.createDuplicateWebhookException();
      }

      // 웹훅 테스트
      const testResult = await this.notificationService.testWebhook(
        createWebhookDto.url,
      );

      if (!testResult.success) {
        throw ApiResponseUtils.createWebhookTestFailedException(
          testResult.error?.message,
          testResult.errorType,
        );
      }

      // 웹훅 생성
      await this.webhookService.create(createWebhookDto.url);

      return ApiResponseUtils.webhookSuccess(testResult);
    } catch (error) {
      ApiResponseUtils.handleError(error, ErrorContext.WEBHOOK_REGISTRATION);
    }
  }

  @Get('notices/recent')
  async getRecentNotices() {
    const notices = await this.crawlingService.getRecentNotices(
      APP_CONSTANTS.CACHE.NOTICES_RECENT_LIMIT,
    );
    return ApiResponseUtils.success(notices);
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
  ) {
    const isDone =
      isDoneRaw === 'true' ? true : isDoneRaw === 'false' ? false : undefined;
    const archiveResult = await this.noticesQueryService.getArchivedNotices({
      page,
      limit,
      search,
      startDate,
      endDate,
      sortOrder: sortOrder === 'asc' ? 'asc' : 'desc',
      isDone,
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
  async getNoticeDetail(@Param('num', ParseIntPipe) num: number) {
    const detail = await this.noticeArchiveService.getArchivedNoticeDetail(num);

    if (!detail) {
      throw new NotFoundException(
        `의안번호 ${num}에 해당하는 아카이브 입법예고를 찾을 수 없습니다.`,
      );
    }

    return ApiResponseUtils.success({
      ...detail,
      aiSummaryEnabled: (await this.healthCheckService.getOllamaMetrics())
        .enabled,
    });
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
      this.isDoneSyncService,
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
}
