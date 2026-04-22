import { Injectable, Logger } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { NotificationService } from './notification.service';
import { LoggerUtils } from '../utils/logger.utils';
import { type CachedNotice } from '../types/cache.types';
import {
  BatchJobResult,
  BatchProcessingOptions,
  BatchProcessingService,
} from './batch-processing.service';

@Injectable()
export class NotificationBatchService {
  private readonly logger = new Logger(NotificationBatchService.name);

  constructor(
    private webhookService: WebhookService,
    private notificationService: NotificationService,
    private batchProcessingService: BatchProcessingService,
  ) {}

  /**
   * Process a batch of notifications for multiple notices, sending them to all active webhooks.
   * Implements immediate deactivation of webhooks that fail on the first attempt, and minimizes logging for temporary failures.
   * @param notices - Array of notices to process notifications for
   * @param options - Batch processing options such as concurrency and retry settings
   * @param executeBatch - Function to execute the batch of jobs, allowing for flexible batch processing strategies
   * @returns An array of results for each notice, including counts of successes, failures, deactivations, and temporary failures
   */
  /**
   * 입법예고 알림 배치 처리 (외부에서 직접 호출)
   */
  async processNotificationBatch(
    notices: CachedNotice[],
    options: BatchProcessingOptions = {},
  ): Promise<string> {
    const jobId = `notification_batch_${Date.now()}`;
    LoggerUtils.logDev(
      NotificationBatchService.name,
      `Starting notification batch processing for ${notices.length} notices`,
    );

    const batchPromise = this.executeNotificationBatch(notices, options);
    // 필요하다면 jobQueue 등 관리 로직 추가 가능

    batchPromise
      .then((results) => {
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;
        this.logger.log(
          `Notification batch completed: ${successCount} success, ${failureCount} failed`,
        );
      })
      .catch((error) => {
        this.logger.error('Batch processing error:', error);
      });

    LoggerUtils.logDev(
      NotificationBatchService.name,
      `Notification batch job ${jobId} started`,
    );

    return jobId;
  }

  /**
   * 실제 알림 배치 실행
   */
  async executeNotificationBatch(
    notices: CachedNotice[],
    options: BatchProcessingOptions = {},
  ): Promise<BatchJobResult[]> {
    const activeWebhooks = (await this.webhookService.findAll()) ?? [];

    if (activeWebhooks.length === 0) {
      LoggerUtils.logDev(
        NotificationBatchService.name,
        'No active webhooks available for notification batch',
      );
    }

    const notificationJobs = notices.map(
      (notice) => async (abortSignal: AbortSignal) => {
        const currentWebhooks = activeWebhooks;

        if (currentWebhooks.length === 0) {
          LoggerUtils.logDev(
            NotificationBatchService.name,
            'No active webhooks available for notification',
          );
          return {
            notice: notice.subject,
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
                NotificationBatchService.name,
                `Webhook ${webhookId} immediately deactivated after first failure for notice: ${notice.subject}`,
              );
            } catch (error) {
              this.logger.error(
                `Failed to deactivate webhook ${webhookId}:`,
                error,
              );
            }
          }

          LoggerUtils.debugDev(
            NotificationBatchService.name,
            `Immediately deactivated ${permanentFailures.length} webhooks that failed on first attempt`,
          );
        }

        if (temporaryFailures.length > 0) {
          LoggerUtils.logDev(
            NotificationBatchService.name,
            `${temporaryFailures.length} webhooks failed temporarily for notice: ${notice.subject}`,
          );
        }

        const successCount = results.filter((r) => r.success).length;

        return {
          notice: notice.subject,
          totalWebhooks: currentWebhooks.length,
          successCount,
          failedCount: permanentFailures.length + temporaryFailures.length,
          deactivated: permanentFailures.length,
          temporaryFailures: temporaryFailures.length,
        };
      },
    );

    return this.batchProcessingService.executeBatch(notificationJobs, options);
  }
}
