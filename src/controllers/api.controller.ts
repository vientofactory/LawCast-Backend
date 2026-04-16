import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  ValidationPipe,
  UsePipes,
  HttpStatus,
  HttpCode,
  Req,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { WebhookService } from '../services/webhook.service';
import { CrawlingService } from '../services/crawling.service';
import { NotificationService } from '../services/notification.service';
import { HashguardService } from '../services/hashguard.service';
import { BatchProcessingService } from '../services/batch-processing.service';
import { NoticeArchiveService } from '../services/notice-archive.service';
import { NoticesQueryService } from '../services/notices-query.service';
import { CreateWebhookDto } from '../dto/create-webhook.dto';
import { WebhookValidationUtils } from '../utils/webhook-validation.utils';
import { ApiResponseUtils, ErrorContext } from '../utils/api-response.utils';
import {
  isProductionNodeEnv,
  sanitizeSearchQuery,
} from '../utils/api-controller.utils';
import { APP_CONSTANTS } from '../config/app.config';

@Controller('api')
export class ApiController {
  constructor(
    private readonly configService: ConfigService,
    private readonly webhookService: WebhookService,
    private readonly crawlingService: CrawlingService,
    private readonly notificationService: NotificationService,
    private readonly hashguardService: HashguardService,
    private readonly batchProcessingService: BatchProcessingService,
    private readonly noticeArchiveService: NoticeArchiveService,
    private readonly noticesQueryService: NoticesQueryService,
  ) {}

  @Post('webhooks')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(
    new ValidationPipe(WebhookValidationUtils.getValidationPipeOptions()),
  )
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
  ) {
    const safePage = Math.max(APP_CONSTANTS.API.PAGINATION.MIN_PAGE, page);
    const safeLimit = Math.min(
      APP_CONSTANTS.API.PAGINATION.MAX_LIMIT,
      Math.max(APP_CONSTANTS.API.PAGINATION.MIN_LIMIT, limit),
    );

    const archiveResult = await this.noticesQueryService.getArchivedNotices({
      page: safePage,
      limit: safeLimit,
      search: sanitizeSearchQuery(search, APP_CONSTANTS.API.SEARCH.MAX_LENGTH),
    });

    return ApiResponseUtils.success(archiveResult);
  }

  @Get('notices/:num/detail')
  async getNoticeDetail(@Param('num', ParseIntPipe) num: number) {
    const detail = await this.noticeArchiveService.getArchivedNoticeDetail(num);

    if (!detail) {
      throw new NotFoundException(
        `의안번호 ${num}에 해당하는 아카이브 입법예고를 찾을 수 없습니다.`,
      );
    }

    return ApiResponseUtils.success(detail);
  }

  @Get('stats')
  async getStats() {
    const [webhookStats, cacheInfo, batchStatus, archiveCount] =
      await Promise.all([
        this.webhookService.getDetailedStats(),
        this.crawlingService.getCacheInfo(),
        this.batchProcessingService.getBatchJobStatus(),
        this.noticeArchiveService.getArchiveCount(),
      ]);

    const isProduction = isProductionNodeEnv(
      this.configService.get<string>('nodeEnv'),
    );
    const safeBatchStatus = isProduction
      ? {
          jobCount: batchStatus.jobCount,
        }
      : batchStatus;

    const safeCacheInfo = isProduction
      ? {
          size: cacheInfo.size,
          maxSize: cacheInfo.maxSize,
          isInitialized: cacheInfo.isInitialized,
        }
      : cacheInfo;

    const safeWebhookStats = isProduction
      ? {
          total: webhookStats.total,
          active: webhookStats.active,
          efficiency: webhookStats.efficiency,
        }
      : webhookStats;

    return ApiResponseUtils.success({
      webhooks: safeWebhookStats,
      cache: safeCacheInfo,
      archive: {
        count: archiveCount,
      },
      batchProcessing: safeBatchStatus,
    });
  }

  @Get('batch/status')
  async getBatchStatus() {
    const isProduction = isProductionNodeEnv(
      this.configService.get<string>('nodeEnv'),
    );
    const status = isProduction
      ? {
          jobCount: this.batchProcessingService.getBatchJobStatus().jobCount,
          jobIds: [],
        }
      : this.batchProcessingService.getDetailedBatchJobStatus();

    return ApiResponseUtils.success(
      status,
      'Batch processing status retrieved successfully',
    );
  }

  @Get('health')
  async getHealth() {
    const isRedisConnected = await this.crawlingService.isRedisConnected();
    const cacheInfo = await this.crawlingService.getCacheInfo();
    const isProduction = isProductionNodeEnv(
      this.configService.get<string>('nodeEnv'),
    );

    const payload = isProduction
      ? {
          timestamp: new Date().toISOString(),
          status: isRedisConnected ? 'healthy' : 'degraded',
        }
      : {
          timestamp: new Date().toISOString(),
          redis: {
            connected: isRedisConnected,
            cache: cacheInfo,
          },
        };

    return ApiResponseUtils.success(payload, 'LawCast API is healthy');
  }

  @Get('webhooks/stats/detailed')
  async getDetailedWebhookStats() {
    const stats = await this.webhookService.getDetailedStats();
    const isProduction = isProductionNodeEnv(
      this.configService.get<string>('nodeEnv'),
    );
    const safeStats = isProduction
      ? {
          total: stats.total,
          active: stats.active,
          efficiency: stats.efficiency,
        }
      : stats;

    return ApiResponseUtils.success(
      safeStats,
      'Detailed webhook statistics retrieved successfully',
    );
  }

  @Get('webhooks/system-health')
  async getSystemHealth() {
    const stats = await this.webhookService.getDetailedStats();
    const efficiency =
      stats.total > 0 ? (stats.active / stats.total) * 100 : 100;
    const isProduction = isProductionNodeEnv(
      this.configService.get<string>('nodeEnv'),
    );
    const safeStats = isProduction
      ? {
          total: stats.total,
          active: stats.active,
          efficiency: stats.efficiency,
        }
      : stats;

    return ApiResponseUtils.success(
      {
        efficiency: Number(efficiency.toFixed(1)),
        stats: safeStats,
        status: efficiency >= 70 ? 'healthy' : 'needs_optimization',
      },
      'System health status retrieved successfully',
    );
  }

  @Get('redis/status')
  async getRedisStatus() {
    const redisStatus = await this.crawlingService.getRedisStatus();

    const isProduction = isProductionNodeEnv(
      this.configService.get<string>('nodeEnv'),
    );

    if (isProduction) {
      return ApiResponseUtils.success(
        {
          connected: redisStatus.connected,
          timestamp: new Date().toISOString(),
        },
        redisStatus.connected
          ? 'Redis status is available'
          : 'Redis is unavailable',
      );
    }

    const message = redisStatus.connected
      ? `Redis is connected (${redisStatus.responseTime}ms response time)`
      : `Redis connection failed: ${redisStatus.error}`;

    return ApiResponseUtils.success(redisStatus, message);
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
