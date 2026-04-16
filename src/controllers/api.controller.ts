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
import { Request } from 'express';
import { WebhookService } from '../services/webhook.service';
import { CrawlingService } from '../services/crawling.service';
import { NotificationService } from '../services/notification.service';
import { HashguardService } from '../services/hashguard.service';
import { BatchProcessingService } from '../services/batch-processing.service';
import { NoticeArchiveService } from '../services/notice-archive.service';
import { CreateWebhookDto } from '../dto/create-webhook.dto';
import { WebhookValidationUtils } from '../utils/webhook-validation.utils';
import { ApiResponseUtils, ErrorContext } from '../utils/api-response.utils';
import { APP_CONSTANTS } from '../config/app.config';
import { type CachedNotice } from '../types/cache.types';

@Controller('api')
export class ApiController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly crawlingService: CrawlingService,
    private readonly notificationService: NotificationService,
    private readonly hashguardService: HashguardService,
    private readonly batchProcessingService: BatchProcessingService,
    private readonly noticeArchiveService: NoticeArchiveService,
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
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('search') search?: string,
  ) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(50, Math.max(1, limit));
    const normalizedSearch = (search || '').trim();

    const [cachedNotices, archiveItems] = await Promise.all([
      this.crawlingService.getRecentNotices(APP_CONSTANTS.CACHE.MAX_SIZE),
      this.noticeArchiveService.listArchiveNotices(normalizedSearch),
    ]);

    const filteredCached = normalizedSearch
      ? cachedNotices.filter((notice) =>
          this.matchesSearchKeyword(notice, normalizedSearch),
        )
      : cachedNotices;

    const mergedByNoticeNum = new Map<number, (typeof archiveItems)[number]>();

    for (const notice of filteredCached) {
      mergedByNoticeNum.set(notice.num, this.mapCachedNoticeToListItem(notice));
    }

    for (const notice of archiveItems) {
      if (!mergedByNoticeNum.has(notice.num)) {
        mergedByNoticeNum.set(notice.num, notice);
      }
    }

    const mergedItems = Array.from(mergedByNoticeNum.values()).sort(
      (a, b) => b.num - a.num,
    );
    const total = mergedItems.length;
    const startIndex = (safePage - 1) * safeLimit;
    const items = mergedItems.slice(startIndex, startIndex + safeLimit);

    return ApiResponseUtils.success({
      items,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      search: normalizedSearch,
      stats: {
        cacheCount: cachedNotices.length,
        matchedCacheCount: filteredCached.length,
        archiveCount: archiveItems.length,
        mergedCount: total,
      },
    });
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

    return ApiResponseUtils.success({
      webhooks: webhookStats,
      cache: cacheInfo,
      archive: {
        count: archiveCount,
      },
      batchProcessing: batchStatus,
    });
  }

  @Get('batch/status')
  async getBatchStatus() {
    const status = this.batchProcessingService.getDetailedBatchJobStatus();
    return ApiResponseUtils.success(
      status,
      'Batch processing status retrieved successfully',
    );
  }

  @Get('health')
  async getHealth() {
    const isRedisConnected = await this.crawlingService.isRedisConnected();
    const cacheInfo = await this.crawlingService.getCacheInfo();

    return ApiResponseUtils.success(
      {
        timestamp: new Date().toISOString(),
        redis: {
          connected: isRedisConnected,
          cache: cacheInfo,
        },
      },
      'LawCast API is healthy',
    );
  }

  @Get('webhooks/stats/detailed')
  async getDetailedWebhookStats() {
    const stats = await this.webhookService.getDetailedStats();
    return ApiResponseUtils.success(
      stats,
      'Detailed webhook statistics retrieved successfully',
    );
  }

  @Get('webhooks/system-health')
  async getSystemHealth() {
    const stats = await this.webhookService.getDetailedStats();
    const efficiency =
      stats.total > 0 ? (stats.active / stats.total) * 100 : 100;

    return ApiResponseUtils.success(
      {
        efficiency: Number(efficiency.toFixed(1)),
        stats,
        status: efficiency >= 70 ? 'healthy' : 'needs_optimization',
      },
      'System health status retrieved successfully',
    );
  }

  @Get('redis/status')
  async getRedisStatus() {
    const redisStatus = await this.crawlingService.getRedisStatus();

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

  private mapCachedNoticeToListItem(notice: CachedNotice) {
    return {
      num: notice.num,
      subject: notice.subject,
      proposerCategory: notice.proposerCategory,
      committee: notice.committee,
      numComments: notice.numComments,
      link: notice.link,
      contentId: notice.contentId ?? null,
      aiSummary: notice.aiSummary ?? null,
      aiSummaryStatus: notice.aiSummaryStatus ?? 'not_requested',
      attachments: {
        pdfFile: notice.attachments?.pdfFile ?? '',
        hwpFile: notice.attachments?.hwpFile ?? '',
      },
      archiveStartedAt: null,
      lastUpdatedAt: null,
    };
  }

  private matchesSearchKeyword(notice: CachedNotice, search: string): boolean {
    const keyword = search.toLowerCase();
    const target = [
      notice.subject,
      notice.proposerCategory,
      notice.committee,
      notice.aiSummary || '',
    ]
      .join(' ')
      .toLowerCase();

    return target.includes(keyword);
  }
}
