import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
import {
  NotificationDeliveryLog,
  type NotificationDeliveryStatus,
} from '../change-tracking/notification-delivery-log.entity';

interface NotificationJobResult {
  notice: string;
  totalWebhooks: number;
  successCount: number;
  failedCount: number;
  deactivated: number;
  temporaryFailures: number;
}

interface ChangeNotificationJobResult {
  noticeNum: number;
  subject: string;
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
    @InjectRepository(NotificationDeliveryLog)
    private readonly deliveryLogRepository: Repository<NotificationDeliveryLog>,
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

    LoggerUtils.logDev(
      NotificationBatchService.name,
      `Starting change-notification batch for ${payloads.length} change event(s)`,
    );

    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      NotificationBatchService.name,
      `Change-notification batch started for **${payloads.length}** event(s)`,
      {
        batchRunId,
        eventCount: payloads.length,
        noticeNums: payloads.map((payload) => payload.noticeNum),
      },
    );

    const batchPromise = this.executeChangeNotificationBatch(payloads, {
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
      this.logger.error(
        `Failed to load webhooks for notification batch, skipping dispatch: ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        NotificationBatchService.name,
        `Webhook load failed, notifications skipped: ${(error as Error).message}`,
      );
      return [];
    }

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
        const { successCount, failedCount, deactivated, temporaryFailures } =
          await this.dispatchToWebhooks(
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
      },
    );

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

    const jobs = payloads.map((payload) => async (abortSignal: AbortSignal) => {
      const {
        successCount,
        failedCount,
        deactivated,
        temporaryFailures,
        results,
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

      await this.persistChangeNotificationDeliveryLogs(payload, results);

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

      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        NotificationBatchService.name,
        `Deactivated **${permanentFailures.length}** permanently-failing webhook(s) for ${context.itemType}: **${context.itemLabel}**`,
        {
          deactivatedCount: permanentFailures.length,
          webhookIds: permanentFailureIds,
          itemType: context.itemType,
          itemLabel: context.itemLabel,
        },
      );
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

  private async persistChangeNotificationDeliveryLogs(
    payload: ChangeNotificationPayload,
    results: Array<{
      webhookId: number;
      success: boolean;
      error?: unknown;
      shouldDelete?: boolean;
    }>,
  ): Promise<void> {
    if (!payload.eventId || !payload.payloadHash || results.length === 0) {
      return;
    }

    const deliveredAt = new Date();
    const rows = results.map((result) => {
      const status: NotificationDeliveryStatus = result.success
        ? 'delivered'
        : result.shouldDelete
          ? 'deactivated'
          : 'failed';
      const errorMeta = result.error as
        | { message?: string; response?: { status?: number } }
        | undefined;

      return this.deliveryLogRepository.create({
        eventId: payload.eventId,
        webhookId: result.webhookId,
        deliveredAt,
        status,
        payloadHash: payload.payloadHash,
        responseCode: errorMeta?.response?.status ?? null,
        errorMessage: result.success
          ? null
          : (errorMeta?.message ?? 'unknown error'),
      });
    });

    await this.deliveryLogRepository.save(rows);
  }
}
