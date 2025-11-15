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

      // 웹훅 생성
      const webhook = await this.webhookService.create({
        url: createWebhookDto.url,
      });

      // 웹훅 테스트
      const testResult = await this.notificationService.testWebhook(
        webhook.url,
      );

      if (!testResult.success && testResult.shouldDelete) {
        await this.webhookService.remove(webhook.id);
        throw ApiResponseUtils.createWebhookTestFailedException(
          testResult.error?.message,
        );
      }

      return ApiResponseUtils.webhookSuccess(testResult);
    } catch (error) {
      ApiResponseUtils.handleError(error, ErrorContext.WEBHOOK_REGISTRATION);
    }
  }

  @Get('notices/recent')
  async getRecentNotices() {
    const notices = this.crawlingService.getRecentNotices(
      APP_CONSTANTS.CACHE.NOTICES_RECENT_LIMIT,
    );
    return ApiResponseUtils.success(notices);
  }

  @Get('stats')
  async getStats() {
    const [webhookStats, cacheInfo, batchStatus] = await Promise.all([
      this.webhookService.getStats(),
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
  getHealth() {
    return ApiResponseUtils.success(
      { timestamp: new Date().toISOString() },
      'LawCast API is healthy',
    );
  }
}
