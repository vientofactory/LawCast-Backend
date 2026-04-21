import { Injectable } from '@nestjs/common';
import {
  BatchProcessingService,
  BatchJobResult,
  BatchProcessingOptions,
} from './batch-processing.service';
import { WebhookService } from './webhook.service';
import { NotificationService } from './notification.service';
import { LoggerUtils } from '../utils/logger.utils';
import { type CachedNotice } from '../types/cache.types';

@Injectable()
export class NotificationBatchProcessor {
  constructor(
    private readonly batchProcessingService: BatchProcessingService,
    private readonly webhookService: WebhookService,
    private readonly notificationService: NotificationService,
  ) {}

  async processNotificationBatch(
    notices: CachedNotice[],
    options: BatchProcessingOptions = {},
  ): Promise<string> {
    const jobId = `notification_batch_${Date.now()}`;
    LoggerUtils.logDev(
      NotificationBatchProcessor.name,
      `Starting notification batch processing for ${notices.length} notices`,
    );

    const notificationJobs = await this.createNotificationJobs(notices);
    // 논블로킹 실행
    const batchPromise = this.batchProcessingService.executeBatch(
      notificationJobs,
      options,
    );
    this.batchProcessingService.registerJob(jobId, batchPromise);
    batchPromise
      .then((results) => {
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;
        LoggerUtils.logDev(
          NotificationBatchProcessor.name,
          `Notification batch completed: ${successCount} success, ${failureCount} failed`,
        );
        this.batchProcessingService.addRecentBatch(jobId, results);
      })
      .catch((error) => {
        LoggerUtils.logDev(
          NotificationBatchProcessor.name,
          'Batch processing error:',
          error,
        );
      })
      .finally(() => {
        this.batchProcessingService.unregisterJob(jobId);
        LoggerUtils.logDev(
          NotificationBatchProcessor.name,
          `Batch job ${jobId} cleaned up`,
        );
      });
    return jobId;
  }

  private async createNotificationJobs(notices: CachedNotice[]) {
    const activeWebhooks = (await this.webhookService.findAll()) ?? [];
    return notices.map(
      (notice) =>
        async (abortSignal: AbortSignal): Promise<BatchJobResult> => {
          const currentWebhooks = activeWebhooks;
          if (currentWebhooks.length === 0) {
            LoggerUtils.logDev(
              NotificationBatchProcessor.name,
              'No active webhooks available for notification',
            );
            return {
              success: false,
              duration: 0,
              totalWebhooks: 0,
              successCount: 0,
              failedCount: 0,
              deactivated: 0,
              temporaryFailures: 0,
            };
          }
          const results =
            await this.notificationService.sendDiscordNotificationBatch(
              notice,
              currentWebhooks,
              abortSignal,
            );
          const permanentFailures = results.filter(
            (result) => !result.success && result.shouldDelete,
          );
          const temporaryFailures = results.filter(
            (result) => !result.success && !result.shouldDelete,
          );
          if (permanentFailures.length > 0) {
            const permanentFailureIds = permanentFailures.map(
              (result) => result.webhookId,
            );
            for (const webhookId of permanentFailureIds) {
              try {
                await this.webhookService.remove(webhookId);
                this.notificationService.clearPermanentFailureFlag(webhookId);
                LoggerUtils.debugDev(
                  NotificationBatchProcessor.name,
                  `Webhook ${webhookId} immediately deactivated after first failure for notice: ${notice.subject}`,
                );
              } catch (error) {
                LoggerUtils.logDev(
                  NotificationBatchProcessor.name,
                  `Failed to deactivate webhook ${webhookId}:`,
                  error,
                );
              }
            }
            LoggerUtils.debugDev(
              NotificationBatchProcessor.name,
              `Immediately deactivated ${permanentFailures.length} webhooks that failed on first attempt`,
            );
          }
          if (temporaryFailures.length > 0) {
            LoggerUtils.logDev(
              NotificationBatchProcessor.name,
              `${temporaryFailures.length} webhooks failed temporarily for notice: ${notice.subject}`,
            );
          }
          const successCount = results.filter((r) => r.success).length;
          return {
            success: true,
            duration: 0, // TODO: 실제 처리 시간 계산 로직 추가
            totalWebhooks: currentWebhooks.length,
            successCount,
            failedCount: permanentFailures.length + temporaryFailures.length,
            deactivated: permanentFailures.length,
            temporaryFailures: temporaryFailures.length,
          };
        },
    );
  }
}
