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
import { CreateWebhookDto } from '../dto/create-webhook.dto';
import { WebhookValidationUtils } from '../utils/webhook-validation.utils';
import { ApiResponseUtils } from '../utils/api-response.utils';

@Controller('api')
export class ApiController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly crawlingService: CrawlingService,
    private readonly notificationService: NotificationService,
    private readonly recaptchaService: RecaptchaService,
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
      ApiResponseUtils.handleError(error, '웹훅 등록');
    }
  }

  @Get('notices/recent')
  async getRecentNotices() {
    const notices = this.crawlingService.getRecentNotices(20);
    return ApiResponseUtils.success(notices);
  }

  @Get('stats')
  async getStats() {
    const [webhookStats, cacheInfo] = await Promise.all([
      this.webhookService.getStats(),
      this.crawlingService.getCacheInfo(),
    ]);

    return ApiResponseUtils.success({
      webhooks: webhookStats,
      cache: cacheInfo,
    });
  }

  @Get('health')
  getHealth() {
    return ApiResponseUtils.success(
      { timestamp: new Date().toISOString() },
      'LawCast API is healthy',
    );
  }
}
