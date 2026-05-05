import { Injectable, Logger, Optional } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { NotificationService } from './notification.service';
import { LoggerUtils } from '../utils/logger.utils';
import { type CachedNotice } from '../types/cache.types';
import {
  BatchJobResult,
  BatchProcessingOptions,
  BatchProcessingService,
} from './batch-processing.service';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';

interface NotificationJobResult {
  notice: string;
  totalWebhooks: number;
  successCount: number;
  failedCount: number;
  deactivated: number;
  temporaryFailures: number;
}

@Injectable()
export class NotificationBatchService {
  private readonly logger = new Logger(NotificationBatchService.name);

  constructor(
    private webhookService: WebhookService,
    private notificationService: NotificationService,
    private batchProcessingService: BatchProcessingService,
    @Optional() private discordBridge: DiscordBridgeService,
  ) {}

  /**
   * Process a batch of notifications for multiple notices, sending them to all active webhooks.
   * Implements immediate deactivation of webhooks that fail on the first attempt, and minimizes logging for temporary failures.
   * @param notices - Array of notices to process notifications for
   * @param options - Batch processing options such as concurrency and retry settings
   * @param executeBatch - Function to execute the batch of jobs, allowing for flexible batch processing strategies
   * @returns An array of results for each notice, including counts of successes, failures, deactivations, and temporary failures
   */
  async processNotificationBatch(
    notices: CachedNotice[],
    options: BatchProcessingOptions = {},
  ): Promise<string> {
    const batchRunId = BatchProcessingService.generateId('notification_batch');
    LoggerUtils.logDev(
      NotificationBatchService.name,
      `Starting notification batch processing for ${notices.length} notices`,
    );

    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      NotificationBatchService.name,
      `Notification batch started for **${notices.length}** notice(s)`,
      { batchRunId, noticeCount: notices.length },
    );

    const batchPromise = this.executeNotificationBatch(notices, {
      ...options,
      batchRunId,
    });

    batchPromise
      .then((results) => {
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;

        const totalWebhooks = results.reduce(
          (sum, r) => sum + ((r.data?.totalWebhooks as number) ?? 0),
          0,
        );
        const deactivated = results.reduce(
          (sum, r) => sum + ((r.data?.deactivated as number) ?? 0),
          0,
        );
        const temporaryFailures = results.reduce(
          (sum, r) => sum + ((r.data?.temporaryFailures as number) ?? 0),
          0,
        );

        this.batchProcessingService.updateRecentJobMetadata(batchRunId, {
          totalWebhooks,
          deactivated,
          temporaryFailures,
        });

        this.logger.log(
          `Notification batch ${batchRunId} completed: ${successCount} success, ${failureCount} failed` +
            ` (webhooks: ${totalWebhooks}, deactivated: ${deactivated}, temporary failures: ${temporaryFailures})`,
        );

        void this.discordBridge?.logEvent(
          failureCount > 0 ? BridgeLogLevel.WARN : BridgeLogLevel.LOG,
          NotificationBatchService.name,
          `Batch **${batchRunId}** completed: ${successCount} success, ${failureCount} failed`,
          {
            batchRunId,
            successCount,
            failureCount,
            totalWebhooks,
            deactivated,
            temporaryFailures,
          },
        );
      })
      .catch((error) => {
        this.logger.error(`Batch ${batchRunId} processing error:`, error);
        void this.discordBridge?.logEvent(
          BridgeLogLevel.ERROR,
          NotificationBatchService.name,
          `Batch **${batchRunId}** failed: ${(error as Error).message}`,
          { batchRunId },
        );
      });

    LoggerUtils.logDev(
      NotificationBatchService.name,
      `Notification batch job ${batchRunId} started`,
    );

    return batchRunId;
  }

  /**
   * Execute the notification batch by sending notifications for each notice to all active webhooks, handling immediate deactivation of permanently failing webhooks and logging temporary failures with minimal verbosity.
   * @param notices - Array of notices to process
   * @param options - Batch processing options such as concurrency and retry settings
   * @returns An array of results for each notice, including counts of successes, failures, deactivations, and temporary failures
   */
  async executeNotificationBatch(
    notices: CachedNotice[],
    options: BatchProcessingOptions = {},
  ): Promise<BatchJobResult<NotificationJobResult>[]> {
    const activeWebhooks = (await this.webhookService.findAll()) ?? [];

    void this.discordBridge?.logEvent(
      BridgeLogLevel.VERBOSE,
      NotificationBatchService.name,
      `Starting notification dispatch - **${activeWebhooks.length}** active webhook(s) found`,
      { webhookCount: activeWebhooks.length },
    );

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

          void this.discordBridge?.logEvent(
            BridgeLogLevel.WARN,
            NotificationBatchService.name,
            `Deactivated **${permanentFailures.length}** permanently-failing webhook(s) for notice: **${notice.subject}**`,
            {
              deactivatedCount: permanentFailures.length,
              webhookIds: permanentFailureIds,
              notice: notice.subject,
            },
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

    return this.batchProcessingService.executeBatch<NotificationJobResult>(
      notificationJobs,
      { ...options, label: 'notification_batch' },
    );
  }
}
