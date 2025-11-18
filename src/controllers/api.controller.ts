import {
  Controller,
  Get,
  Post,
  Body,
  ValidationPipe,
  UsePipes,
  HttpStatus,
  HttpCode,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhookService } from '../services/webhook.service';
import { CrawlingService } from '../services/crawling.service';
import { NotificationService } from '../services/notification.service';
import { RecaptchaService } from '../services/recaptcha.service';
import { BatchProcessingService } from '../services/batch-processing.service';
import { CreateWebhookDto } from '../dto/create-webhook.dto';
import { WebhookValidationUtils } from '../utils/webhook-validation.utils';
import { ApiResponseUtils, ErrorContext } from '../utils/api-response.utils';
import { APP_CONSTANTS } from '../config/app.config';

@Controller('api')
export class ApiController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly crawlingService: CrawlingService,
    private readonly notificationService: NotificationService,
    private readonly recaptchaService: RecaptchaService,
    private readonly batchProcessingService: BatchProcessingService,
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

      // reCAPTCHA 검증
      const clientIp = WebhookValidationUtils.extractClientIp(req);
      const isRecaptchaValid = await this.recaptchaService.verifyToken(
        createWebhookDto.recaptchaToken,
        clientIp,
      );

      if (!isRecaptchaValid) {
        throw ApiResponseUtils.createRecaptchaFailedException();
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
      await this.webhookService.create({
        url: createWebhookDto.url,
      });

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

  @Get('stats')
  async getStats() {
    const [webhookStats, cacheInfo, batchStatus] = await Promise.all([
      this.webhookService.getDetailedStats(),
      this.crawlingService.getCacheInfo(),
      this.batchProcessingService.getBatchJobStatus(),
    ]);

    return ApiResponseUtils.success({
      webhooks: webhookStats,
      cache: cacheInfo,
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
}
