import { Injectable, Optional } from '@nestjs/common';
import { WebhookService } from '../webhook/webhook.service';
import {
  NotificationService,
  type ChangeNotificationPayload,
} from './notification.service';
import { LoggerUtils } from '../../utils/logger.utils';
import { type CachedNotice } from '../../types/cache.types';
import {
  BatchJobResult,
  BatchProcessingOptions,
  BatchProcessingService,
} from '../shared/batch-processing.service';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { logAndBridge } from '../../utils/bridge-log.utils';

interface NotificationJobResult {
  notice: string;
  totalWebhooks: number;
  successCount: number;
  failedCount: number;
  deactivated: number;
  temporaryFailures: number;
  aggregatedNoticeCount?: number;
}

interface ChangeNotificationJobResult {
  noticeNum: number;
  subject: string;
  totalWebhooks: number;
  successCount: number;
  failedCount: number;
  deactivated: number;
  temporaryFailures: number;
  aggregatedEventCount?: number;
  aggregatedNoticeCount?: number;
}

@Injectable()
export class NotificationBatchService {
  private readonly logger = LoggerUtils.getContextLogger(
    NotificationBatchService.name,
  );

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
    logAndBridge({
      logger: {
        log: (message: string) =>
          LoggerUtils.logDev(NotificationBatchService.name, message),
      },
      method: 'log',
      message: `Starting notification batch processing for ${notices.length} notices`,
      context: NotificationBatchService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.LOG,
      bridgeMessage: `Notification batch started for **${notices.length}** notice(s)`,
      metadata: { batchRunId, noticeCount: notices.length },
    });

    const batchPromise = this.executeNotificationBatch(notices, {
      ...options,
      batchRunId,
    });

    batchPromise
      .then((results) => {
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;

        const totalWebhooks = results.reduce(
          (sum, r) => sum + (r.data.totalWebhooks ?? 0),
          0,
        );
        const deactivated = results.reduce(
          (sum, r) => sum + (r.data.deactivated ?? 0),
          0,
        );
        const temporaryFailures = results.reduce(
          (sum, r) => sum + (r.data.temporaryFailures ?? 0),
          0,
        );

        this.batchProcessingService.updateRecentJobMetadata(batchRunId, {
          totalWebhooks,
          deactivated,
          temporaryFailures,
        });

        logAndBridge({
          logger: this.logger,
          method: 'log',
          message:
            `Notification batch ${batchRunId} completed: ${successCount} success, ${failureCount} failed` +
            ` (webhooks: ${totalWebhooks}, deactivated: ${deactivated}, temporary failures: ${temporaryFailures})`,
          context: NotificationBatchService.name,
          discordBridge: this.discordBridge,
          bridgeLevel:
            failureCount > 0 ? BridgeLogLevel.WARN : BridgeLogLevel.LOG,
          bridgeMessage: `Batch **${batchRunId}** completed: ${successCount} success, ${failureCount} failed`,
          metadata: {
            batchRunId,
            successCount,
            failureCount,
            totalWebhooks,
            deactivated,
            temporaryFailures,
          },
        });
      })
      .catch((error) => {
        logAndBridge({
          logger: this.logger,
          method: 'error',
          message: `Batch ${batchRunId} processing error:`,
          loggerArgs: [error],
          context: NotificationBatchService.name,
          discordBridge: this.discordBridge,
          bridgeLevel: BridgeLogLevel.ERROR,
          bridgeMessage: `Batch **${batchRunId}** failed: ${(error as Error).message}`,
          metadata: { batchRunId },
        });
      });

    LoggerUtils.logDev(
      NotificationBatchService.name,
      `Notification batch job ${batchRunId} started`,
    );

    return batchRunId;
  }

  async processChangeNotificationBatch(
    payloadOrPayloads: ChangeNotificationPayload | ChangeNotificationPayload[],
    options: BatchProcessingOptions = {},
  ): Promise<string> {
    const payloads = Array.isArray(payloadOrPayloads)
      ? payloadOrPayloads
      : [payloadOrPayloads];

    if (payloads.length === 0) {
      return BatchProcessingService.generateId('change_notification_batch');
    }

    const batchRunId = BatchProcessingService.generateId(
      'change_notification_batch',
    );
    logAndBridge({
      logger: {
        log: (message: string) =>
          LoggerUtils.logDev(NotificationBatchService.name, message),
      },
      method: 'log',
      message: `Starting change-notification batch for ${payloads.length} change event(s)`,
      context: NotificationBatchService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.LOG,
      bridgeMessage: `Change-notification batch started for **${payloads.length}** event(s)`,
      metadata: {
        batchRunId,
        eventCount: payloads.length,
        noticeNums: payloads.map((payload) => payload.noticeNum),
      },
    });

    const batchPromise = this.executeChangeNotificationBatch(payloads, {
      ...options,
      batchRunId,
    });

    batchPromise
      .then((results) => {
        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.length - successCount;

        const totalWebhooks = results.reduce(
          (sum, r) => sum + (r.data.totalWebhooks ?? 0),
          0,
        );
        const deactivated = results.reduce(
          (sum, r) => sum + (r.data.deactivated ?? 0),
          0,
        );
        const temporaryFailures = results.reduce(
          (sum, r) => sum + (r.data.temporaryFailures ?? 0),
          0,
        );

        this.batchProcessingService.updateRecentJobMetadata(batchRunId, {
          totalWebhooks,
          deactivated,
          temporaryFailures,
          eventCount: payloads.length,
          noticeNums: payloads.map((payload) => payload.noticeNum),
        });

        this.logger.log(
          `Change batch ${batchRunId} completed: ${successCount} success, ${failureCount} failed` +
            ` (webhooks: ${totalWebhooks}, deactivated: ${deactivated}, temporary failures: ${temporaryFailures})`,
        );
      })
      .catch((error) => {
        this.logger.error(
          `Change batch ${batchRunId} processing error:`,
          error,
        );
      });

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
    // Guard: DB failure must not crash the entire notification pipeline
    let activeWebhooks: Awaited<ReturnType<typeof this.webhookService.findAll>>;
    try {
      activeWebhooks = (await this.webhookService.findAll()) ?? [];
    } catch (error) {
      logAndBridge({
        logger: this.logger,
        method: 'error',
        message: `Failed to load webhooks for notification batch, skipping dispatch: ${(error as Error).message}`,
        context: NotificationBatchService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.ERROR,
        bridgeMessage: `Webhook load failed, notifications skipped: ${(error as Error).message}`,
      });
      return [];
    }

    logAndBridge({
      method: 'verbose',
      message: `starting notification dispatch webhookCount=${activeWebhooks.length}`,
      context: NotificationBatchService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.VERBOSE,
      bridgeMessage: `Starting notification dispatch - **${activeWebhooks.length}** active webhook(s) found`,
      metadata: { webhookCount: activeWebhooks.length },
    });

    if (activeWebhooks.length === 0) {
      LoggerUtils.logDev(
        NotificationBatchService.name,
        'No active webhooks available for notification batch',
      );
    }

    const notificationJobs =
      notices.length > 1
        ? [
            async (abortSignal: AbortSignal) => {
              const {
                successCount,
                failedCount,
                deactivated,
                temporaryFailures,
              } = await this.dispatchToWebhooks(
                activeWebhooks,
                (webhooks) =>
                  this.notificationService.sendDiscordNotificationDigestBatch(
                    notices,
                    webhooks,
                    abortSignal,
                  ),
                {
                  itemLabel: `${notices.length} notices`,
                  itemType: 'notice',
                },
              );

              return {
                notice: `신규 ${notices.length}건 요약`,
                totalWebhooks: activeWebhooks.length,
                successCount,
                failedCount,
                deactivated,
                temporaryFailures,
                aggregatedNoticeCount: notices.length,
              };
            },
          ]
        : notices.map((notice) => async (abortSignal: AbortSignal) => {
            const {
              successCount,
              failedCount,
              deactivated,
              temporaryFailures,
            } = await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordNotificationBatch(
                  notice,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: notice.subject,
                itemType: 'notice',
              },
            );

            return {
              notice: notice.subject,
              totalWebhooks: activeWebhooks.length,
              successCount,
              failedCount,
              deactivated,
              temporaryFailures,
            };
          });

    return this.batchProcessingService.executeBatch<NotificationJobResult>(
      notificationJobs,
      { ...options, label: 'notification_batch' },
    );
  }

  async executeChangeNotificationBatch(
    payloads: ChangeNotificationPayload[],
    options: BatchProcessingOptions = {},
  ): Promise<BatchJobResult<ChangeNotificationJobResult>[]> {
    if (payloads.length === 0) {
      return [];
    }

    let activeWebhooks: Awaited<ReturnType<typeof this.webhookService.findAll>>;
    try {
      activeWebhooks = (await this.webhookService.findAll()) ?? [];
    } catch (error) {
      this.logger.error(
        `Failed to load webhooks for change-notification batch, skipping dispatch: ${(error as Error).message}`,
      );
      return [];
    }

    const jobs =
      payloads.length > 1
        ? [
            async (abortSignal: AbortSignal) => {
              const uniqueNoticeCount = new Set(
                payloads.map((payload) => payload.noticeNum),
              ).size;
              const {
                successCount,
                failedCount,
                deactivated,
                temporaryFailures,
              } = await this.dispatchToWebhooks(
                activeWebhooks,
                (webhooks) =>
                  this.notificationService.sendDiscordChangeDigestNotificationBatch(
                    payloads,
                    webhooks,
                    abortSignal,
                  ),
                {
                  itemLabel: `${payloads.length} events across ${uniqueNoticeCount} notices`,
                  itemType: 'change',
                },
              );

              return {
                noticeNum: payloads[0].noticeNum,
                subject: `변경 ${payloads.length}건 요약`,
                totalWebhooks: activeWebhooks.length,
                successCount,
                failedCount,
                deactivated,
                temporaryFailures,
                aggregatedEventCount: payloads.length,
                aggregatedNoticeCount: uniqueNoticeCount,
              };
            },
          ]
        : payloads.map((payload) => async (abortSignal: AbortSignal) => {
            const {
              successCount,
              failedCount,
              deactivated,
              temporaryFailures,
            } = await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordChangeNotificationBatch(
                  payload,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: `${payload.noticeNum}:${payload.subject}`,
                itemType: 'change',
              },
            );

            return {
              noticeNum: payload.noticeNum,
              subject: payload.subject,
              totalWebhooks: activeWebhooks.length,
              successCount,
              failedCount,
              deactivated,
              temporaryFailures,
            };
          });

    return this.batchProcessingService.executeBatch<ChangeNotificationJobResult>(
      jobs,
      { ...options, label: 'change_notification_batch' },
    );
  }

  private async dispatchToWebhooks(
    webhooks: Awaited<ReturnType<typeof this.webhookService.findAll>>,
    send: (
      webhooks: Awaited<ReturnType<typeof this.webhookService.findAll>>,
    ) => Promise<
      Array<{
        webhookId: number;
        success: boolean;
        error?: unknown;
        shouldDelete?: boolean;
      }>
    >,
    context: { itemLabel: string; itemType: 'notice' | 'change' },
  ): Promise<{
    successCount: number;
    failedCount: number;
    deactivated: number;
    temporaryFailures: number;
    results: Array<{
      webhookId: number;
      success: boolean;
      error?: unknown;
      shouldDelete?: boolean;
    }>;
  }> {
    if (webhooks.length === 0) {
      LoggerUtils.logDev(
        NotificationBatchService.name,
        `No active webhooks available for ${context.itemType} notification`,
      );

      return {
        successCount: 0,
        failedCount: 0,
        deactivated: 0,
        temporaryFailures: 0,
        results: [],
      };
    }

    const results = await send(webhooks);

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
            `Webhook ${webhookId} immediately deactivated after first failure for ${context.itemType}: ${context.itemLabel}`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to deactivate webhook ${webhookId}:`,
            error,
          );
        }
      }

      logAndBridge({
        logger: this.logger,
        method: 'warn',
        message: `Deactivated ${permanentFailures.length} permanently-failing webhook(s) for ${context.itemType}: ${context.itemLabel}`,
        context: NotificationBatchService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.WARN,
        bridgeMessage: `Deactivated **${permanentFailures.length}** permanently-failing webhook(s) for ${context.itemType}: **${context.itemLabel}**`,
        metadata: {
          deactivatedCount: permanentFailures.length,
          webhookIds: permanentFailureIds,
          itemType: context.itemType,
          itemLabel: context.itemLabel,
        },
      });
    }

    if (temporaryFailures.length > 0) {
      LoggerUtils.logDev(
        NotificationBatchService.name,
        `${temporaryFailures.length} webhooks failed temporarily for ${context.itemType}: ${context.itemLabel}`,
      );
    }

    const successCount = results.filter((r) => r.success).length;
    return {
      successCount,
      failedCount: permanentFailures.length + temporaryFailures.length,
      deactivated: permanentFailures.length,
      temporaryFailures: temporaryFailures.length,
      results,
    };
  }
}
