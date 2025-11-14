import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  ValidationPipe,
  UsePipes,
  HttpStatus,
  HttpCode,
  HttpException,
} from '@nestjs/common';
import { WebhookService } from '../services/webhook.service';
import { CrawlingService } from '../services/crawling.service';
import { NotificationService } from '../services/notification.service';
import { RecaptchaService } from '../services/recaptcha.service';
import { CreateWebhookDto } from '../dto/create-webhook.dto';

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
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async createWebhook(@Body() createWebhookDto: CreateWebhookDto) {
    // reCAPTCHA 검증
    const isRecaptchaValid = await this.recaptchaService.verifyToken(
      createWebhookDto.recaptchaToken,
    );

    if (!isRecaptchaValid) {
      throw new HttpException(
        'reCAPTCHA verification failed',
        HttpStatus.BAD_REQUEST,
      );
    }

    const webhook = await this.webhookService.create({
      url: createWebhookDto.url,
    });

    // 웹훅 테스트 전송 및 실패 체크
    const testResult = await this.notificationService.testWebhook(webhook.url);

    if (!testResult.success && testResult.shouldDelete) {
      // 테스트 실패시 자동 삭제
      await this.webhookService.remove(webhook.id);
      throw new HttpException(
        'Webhook test failed - invalid or inaccessible webhook URL',
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      success: true,
      message: testResult.success
        ? '웹훅이 성공적으로 등록되고 테스트되었습니다'
        : '웹훅은 등록되었지만 테스트에 실패했습니다 (일시적 오류)',
      testResult: {
        success: testResult.success,
        error: testResult.error?.message || null,
      },
    };
  }

  @Get('notices/recent')
  async getRecentNotices() {
    const notices = this.crawlingService.getRecentNotices(20);
    return {
      success: true,
      data: notices,
    };
  }

  @Get('stats')
  async getStats() {
    const [webhookStats, cacheInfo] = await Promise.all([
      this.webhookService.getStats(),
      this.crawlingService.getCacheInfo(),
    ]);

    return {
      success: true,
      data: {
        webhooks: webhookStats,
        cache: cacheInfo,
      },
    };
  }

  @Get('health')
  getHealth() {
    return {
      success: true,
      message: 'LawCast API is healthy',
      timestamp: new Date().toISOString(),
    };
  }
}
