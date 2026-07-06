import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import { WebhookService } from '../webhook/webhook.service';
import { CreateWebhookDto } from '../webhook/dto/create-webhook.dto';
import { HashguardService } from '../shared/hashguard.service';
import { WebhookValidationUtils } from '../../utils/webhook-validation.utils';
import { ApiResponseUtils, ErrorContext } from '../../utils/api-response.utils';
import { NotificationService } from './notification.service';

@Injectable()
export class WebhookRegistrationService {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly hashguardService: HashguardService,
    private readonly notificationService: NotificationService,
  ) {}

  async registerWebhook(createWebhookDto: CreateWebhookDto, req: Request) {
    try {
      WebhookValidationUtils.validateDiscordWebhookUrl(createWebhookDto.url);

      const clientIp = WebhookValidationUtils.extractClientIp(req);
      const isProofValid = await this.hashguardService.verifyProof(
        createWebhookDto.proof,
        clientIp,
      );

      if (!isProofValid) {
        throw ApiResponseUtils.createPoWFailedException();
      }

      const existingWebhook = await this.webhookService.findByUrl(
        createWebhookDto.url,
      );
      if (existingWebhook) {
        throw ApiResponseUtils.createDuplicateWebhookException();
      }

      const testResult = await this.notificationService.testWebhook(
        createWebhookDto.url,
      );
      if (!testResult.success) {
        throw ApiResponseUtils.createWebhookTestFailedException(
          testResult.error?.message,
          testResult.errorType,
        );
      }

      await this.webhookService.create(createWebhookDto.url);
      return ApiResponseUtils.webhookSuccess(testResult);
    } catch (error) {
      ApiResponseUtils.handleError(error, ErrorContext.WEBHOOK_REGISTRATION);
    }
  }
}
