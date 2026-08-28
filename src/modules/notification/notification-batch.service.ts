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
import { WebPushSubscriptionService } from './web-push-subscription.service';
import {
  WebPushDispatchSummary,
  WebPushNotificationService,
} from './web-push-notification.service';
import { WebPushSubscription } from './web-push-subscription.entity';

interface NotificationJobResult {
  notice: string;
  totalWebhooks: number;
  totalPushSubscriptions: number;
  successCount: number;
  failedCount: number;
  deactivated: number;
  temporaryFailures: number;
  webPushSuccessCount: number;
  webPushFailedCount: number;
  webPushDeactivatedCount: number;
  aggregatedNoticeCount?: number;
}

interface ChangeNotificationJobResult {
  noticeNum: number;
  subject: string;
  totalWebhooks: number;
  totalPushSubscriptions: number;
  successCount: number;
  failedCount: number;
  deactivated: number;
  temporaryFailures: number;
  webPushSuccessCount: number;
  webPushFailedCount: number;
  webPushDeactivatedCount: number;
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
    private webPushSubscriptionService: WebPushSubscriptionService,
    private webPushNotificationService: WebPushNotificationService,
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
        const totalPushSubscriptions = results.reduce(
          (sum, r) => sum + (r.data.totalPushSubscriptions ?? 0),
          0,
        );
        const webPushSuccessCount = results.reduce(
          (sum, r) => sum + (r.data.webPushSuccessCount ?? 0),
          0,
        );
        const webPushDispatchFailures = results.reduce(
          (sum, r) => sum + (r.data.webPushFailedCount ?? 0),
          0,
        );
        const webPushDeactivated = results.reduce(
          (sum, r) => sum + (r.data.webPushDeactivatedCount ?? 0),
          0,
        );

        this.batchProcessingService.updateRecentJobMetadata(batchRunId, {
          totalWebhooks,
          deactivated,
          temporaryFailures,
          totalPushSubscriptions,
          webPushSuccessCount,
          webPushDispatchFailures,
          webPushDeactivated,
        });

        logAndBridge({
          logger: this.logger,
          method: 'log',
          message:
            `Notification batch ${batchRunId} completed: ${successCount} success, ${failureCount} failed` +
            ` (webhooks: ${totalWebhooks}, deactivated: ${deactivated}, temporary failures: ${temporaryFailures}, web push targets: ${totalPushSubscriptions}, web push success: ${webPushSuccessCount}, web push failures: ${webPushDispatchFailures}, web push deactivated: ${webPushDeactivated})`,
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
            totalPushSubscriptions,
            webPushSuccessCount,
            webPushDispatchFailures,
            webPushDeactivated,
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
        const totalPushSubscriptions = results.reduce(
          (sum, r) => sum + (r.data.totalPushSubscriptions ?? 0),
          0,
        );
        const webPushSuccessCount = results.reduce(
          (sum, r) => sum + (r.data.webPushSuccessCount ?? 0),
          0,
        );
        const webPushDispatchFailures = results.reduce(
          (sum, r) => sum + (r.data.webPushFailedCount ?? 0),
          0,
        );
        const webPushDeactivated = results.reduce(
          (sum, r) => sum + (r.data.webPushDeactivatedCount ?? 0),
          0,
        );

        this.batchProcessingService.updateRecentJobMetadata(batchRunId, {
          totalWebhooks,
          deactivated,
          temporaryFailures,
          totalPushSubscriptions,
          webPushSuccessCount,
          webPushDispatchFailures,
          webPushDeactivated,
          eventCount: payloads.length,
          noticeNums: payloads.map((payload) => payload.noticeNum),
        });

        this.logger.log(
          `Change batch ${batchRunId} completed: ${successCount} success, ${failureCount} failed` +
            ` (webhooks: ${totalWebhooks}, deactivated: ${deactivated}, temporary failures: ${temporaryFailures}, web push targets: ${totalPushSubscriptions}, web push success: ${webPushSuccessCount}, web push failures: ${webPushDispatchFailures}, web push deactivated: ${webPushDeactivated})`,
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

    if (activeWebhooks.length === 0) {
      LoggerUtils.logDev(
        NotificationBatchService.name,
        'No active webhooks available for notification batch',
      );
    }

    let activePushSubscriptions: WebPushSubscription[];
    try {
      activePushSubscriptions =
        await this.webPushSubscriptionService.findAllActive();
    } catch (error) {
      this.logger.error(
        `Failed to load web push subscriptions for notification batch: ${(error as Error).message}`,
      );
      activePushSubscriptions = [];
    }

    logAndBridge({
      method: 'verbose',
      message: `starting notification dispatch webhookCount=${activeWebhooks.length} pushSubscriptionCount=${activePushSubscriptions.length}`,
      context: NotificationBatchService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.VERBOSE,
      bridgeMessage: `Starting notification dispatch - **${activeWebhooks.length}** active webhook(s), **${activePushSubscriptions.length}** active push subscription(s)`,
      metadata: {
        webhookCount: activeWebhooks.length,
        pushSubscriptionCount: activePushSubscriptions.length,
      },
    });

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

              const webPushDispatch = await this.dispatchToWebPush(
                activePushSubscriptions,
                (subscriptions) =>
                  this.webPushNotificationService.sendNewNoticeDigestBatch(
                    notices,
                    subscriptions,
                  ),
              );

              return {
                notice: `신규 ${notices.length}건 요약`,
                totalWebhooks: activeWebhooks.length,
                totalPushSubscriptions: webPushDispatch.targetCount,
                successCount,
                failedCount,
                deactivated,
                temporaryFailures,
                webPushSuccessCount: webPushDispatch.successCount,
                webPushFailedCount: webPushDispatch.failedCount,
                webPushDeactivatedCount: webPushDispatch.deactivatedCount,
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

            const webPushDispatch = await this.dispatchToWebPush(
              activePushSubscriptions,
              (subscriptions) =>
                this.webPushNotificationService.sendNewNoticeBatch(
                  notice,
                  subscriptions,
                ),
            );

            return {
              notice: notice.subject,
              totalWebhooks: activeWebhooks.length,
              totalPushSubscriptions: webPushDispatch.targetCount,
              successCount,
              failedCount,
              deactivated,
              temporaryFailures,
              webPushSuccessCount: webPushDispatch.successCount,
              webPushFailedCount: webPushDispatch.failedCount,
              webPushDeactivatedCount: webPushDispatch.deactivatedCount,
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

    // source_deleted is identified first so other categories can exclude it
    // and avoid duplicate notifications (e.g. a newly source_deleted bill
    // also has isDone changed from false→true, which would otherwise hit
    // both noticePeriodEnded and sourceDeleted paths).
    const sourceDeletedPayloads = payloads.filter(
      (payload) =>
        payload.source === 'archive:source-missing' ||
        (payload.changedFields.includes('lifecycleStatus') &&
          payload.changedFields.includes('sourceDeletedAt')),
    );
    const isSourceDeletedNum = new Set(
      sourceDeletedPayloads.map((p) => p.noticeNum),
    );
    const isSourceDeleted = (payload: ChangeNotificationPayload) =>
      isSourceDeletedNum.has(payload.noticeNum);

    const noticePeriodEndedPayloads = payloads.filter(
      (payload) =>
        payload.changedFields.includes('isDone') && !isSourceDeleted(payload),
    );
    const nsmToPalTransitionPayloads = payloads.filter(
      (payload) =>
        !payload.changedFields.includes('isDone') &&
        payload.source !== 'archive:source-missing' &&
        payload.isNsmToPalTransition === true &&
        !isSourceDeleted(payload),
    );
    const regularPayloads = payloads.filter(
      (payload) =>
        !payload.changedFields.includes('isDone') &&
        payload.source !== 'archive:source-missing' &&
        payload.isNsmToPalTransition !== true &&
        !isSourceDeleted(payload),
    );

    let activeWebhooks: Awaited<ReturnType<typeof this.webhookService.findAll>>;
    try {
      activeWebhooks = (await this.webhookService.findAll()) ?? [];
    } catch (error) {
      this.logger.error(
        `Failed to load webhooks for change-notification batch, skipping dispatch: ${(error as Error).message}`,
      );
      return [];
    }

    let activePushSubscriptions: WebPushSubscription[];
    try {
      activePushSubscriptions =
        await this.webPushSubscriptionService.findAllActive();
    } catch (error) {
      this.logger.error(
        `Failed to load web push subscriptions for change batch: ${(error as Error).message}`,
      );
      activePushSubscriptions = [];
    }

    const jobs: Array<
      (abortSignal: AbortSignal) => Promise<ChangeNotificationJobResult>
    > = [];

    if (regularPayloads.length > 0) {
      if (regularPayloads.length > 1) {
        jobs.push(async (abortSignal: AbortSignal) => {
          const uniqueNoticeCount = new Set(
            regularPayloads.map((payload) => payload.noticeNum),
          ).size;
          const { successCount, failedCount, deactivated, temporaryFailures } =
            await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordChangeDigestNotificationBatch(
                  regularPayloads,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: `${regularPayloads.length} events across ${uniqueNoticeCount} notices`,
                itemType: 'change',
              },
            );

          const webPushDispatch = await this.dispatchToWebPush(
            activePushSubscriptions,
            (subscriptions) =>
              this.webPushNotificationService.sendChangeDigestBatch(
                regularPayloads,
                subscriptions,
                { ended: false },
              ),
          );

          return {
            noticeNum: regularPayloads[0].noticeNum,
            subject: `변경 ${regularPayloads.length}건 요약`,
            totalWebhooks: activeWebhooks.length,
            totalPushSubscriptions: webPushDispatch.targetCount,
            successCount,
            failedCount,
            deactivated,
            temporaryFailures,
            webPushSuccessCount: webPushDispatch.successCount,
            webPushFailedCount: webPushDispatch.failedCount,
            webPushDeactivatedCount: webPushDispatch.deactivatedCount,
            aggregatedEventCount: regularPayloads.length,
            aggregatedNoticeCount: uniqueNoticeCount,
          };
        });
      } else {
        jobs.push(async (abortSignal: AbortSignal) => {
          const payload = regularPayloads[0];
          const { successCount, failedCount, deactivated, temporaryFailures } =
            await this.dispatchToWebhooks(
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

          const webPushDispatch = await this.dispatchToWebPush(
            activePushSubscriptions,
            (subscriptions) =>
              this.webPushNotificationService.sendChangeBatch(
                payload,
                subscriptions,
              ),
          );

          return {
            noticeNum: payload.noticeNum,
            subject: payload.subject,
            totalWebhooks: activeWebhooks.length,
            totalPushSubscriptions: webPushDispatch.targetCount,
            successCount,
            failedCount,
            deactivated,
            temporaryFailures,
            webPushSuccessCount: webPushDispatch.successCount,
            webPushFailedCount: webPushDispatch.failedCount,
            webPushDeactivatedCount: webPushDispatch.deactivatedCount,
          };
        });
      }
    }

    if (noticePeriodEndedPayloads.length > 0) {
      if (noticePeriodEndedPayloads.length > 1) {
        jobs.push(async (abortSignal: AbortSignal) => {
          const uniqueNoticeCount = new Set(
            noticePeriodEndedPayloads.map((payload) => payload.noticeNum),
          ).size;
          const { successCount, failedCount, deactivated, temporaryFailures } =
            await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordNoticePeriodEndedDigestBatch(
                  noticePeriodEndedPayloads,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: `${noticePeriodEndedPayloads.length} ended events across ${uniqueNoticeCount} notices`,
                itemType: 'change',
              },
            );

          const webPushDispatch = await this.dispatchToWebPush(
            activePushSubscriptions,
            (subscriptions) =>
              this.webPushNotificationService.sendChangeDigestBatch(
                noticePeriodEndedPayloads,
                subscriptions,
                { ended: true },
              ),
          );

          return {
            noticeNum: noticePeriodEndedPayloads[0].noticeNum,
            subject: `입법예고 종료 ${noticePeriodEndedPayloads.length}건 요약`,
            totalWebhooks: activeWebhooks.length,
            totalPushSubscriptions: webPushDispatch.targetCount,
            successCount,
            failedCount,
            deactivated,
            temporaryFailures,
            webPushSuccessCount: webPushDispatch.successCount,
            webPushFailedCount: webPushDispatch.failedCount,
            webPushDeactivatedCount: webPushDispatch.deactivatedCount,
            aggregatedEventCount: noticePeriodEndedPayloads.length,
            aggregatedNoticeCount: uniqueNoticeCount,
          };
        });
      } else {
        jobs.push(async (abortSignal: AbortSignal) => {
          const payload = noticePeriodEndedPayloads[0];
          const { successCount, failedCount, deactivated, temporaryFailures } =
            await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordNoticePeriodEndedBatch(
                  payload,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: `${payload.noticeNum}:${payload.subject}`,
                itemType: 'change',
              },
            );

          const webPushDispatch = await this.dispatchToWebPush(
            activePushSubscriptions,
            (subscriptions) =>
              this.webPushNotificationService.sendChangeBatch(
                payload,
                subscriptions,
              ),
          );

          return {
            noticeNum: payload.noticeNum,
            subject: payload.subject,
            totalWebhooks: activeWebhooks.length,
            totalPushSubscriptions: webPushDispatch.targetCount,
            successCount,
            failedCount,
            deactivated,
            temporaryFailures,
            webPushSuccessCount: webPushDispatch.successCount,
            webPushFailedCount: webPushDispatch.failedCount,
            webPushDeactivatedCount: webPushDispatch.deactivatedCount,
          };
        });
      }
    }

    if (nsmToPalTransitionPayloads.length > 0) {
      if (nsmToPalTransitionPayloads.length > 1) {
        jobs.push(async (abortSignal: AbortSignal) => {
          const uniqueNoticeCount = new Set(
            nsmToPalTransitionPayloads.map((payload) => payload.noticeNum),
          ).size;
          const { successCount, failedCount, deactivated, temporaryFailures } =
            await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordNsmToPalTransitionDigestBatch(
                  nsmToPalTransitionPayloads,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: `${nsmToPalTransitionPayloads.length} nsm-to-pal transitions across ${uniqueNoticeCount} notices`,
                itemType: 'change',
              },
            );

          const webPushDispatch = await this.dispatchToWebPush(
            activePushSubscriptions,
            (subscriptions) =>
              this.webPushNotificationService.sendChangeDigestBatch(
                nsmToPalTransitionPayloads,
                subscriptions,
                { ended: false, nsmToPalTransition: true },
              ),
          );

          return {
            noticeNum: nsmToPalTransitionPayloads[0].noticeNum,
            subject: `국회 입법예고로 이관 ${nsmToPalTransitionPayloads.length}건 요약`,
            totalWebhooks: activeWebhooks.length,
            totalPushSubscriptions: webPushDispatch.targetCount,
            successCount,
            failedCount,
            deactivated,
            temporaryFailures,
            webPushSuccessCount: webPushDispatch.successCount,
            webPushFailedCount: webPushDispatch.failedCount,
            webPushDeactivatedCount: webPushDispatch.deactivatedCount,
            aggregatedEventCount: nsmToPalTransitionPayloads.length,
            aggregatedNoticeCount: uniqueNoticeCount,
          };
        });
      } else {
        jobs.push(async (abortSignal: AbortSignal) => {
          const payload = nsmToPalTransitionPayloads[0];
          const { successCount, failedCount, deactivated, temporaryFailures } =
            await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordNsmToPalTransitionBatch(
                  payload,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: `${payload.noticeNum}:${payload.subject}`,
                itemType: 'change',
              },
            );

          const webPushDispatch = await this.dispatchToWebPush(
            activePushSubscriptions,
            (subscriptions) =>
              this.webPushNotificationService.sendChangeBatch(
                payload,
                subscriptions,
              ),
          );

          return {
            noticeNum: payload.noticeNum,
            subject: payload.subject,
            totalWebhooks: activeWebhooks.length,
            totalPushSubscriptions: webPushDispatch.targetCount,
            successCount,
            failedCount,
            deactivated,
            temporaryFailures,
            webPushSuccessCount: webPushDispatch.successCount,
            webPushFailedCount: webPushDispatch.failedCount,
            webPushDeactivatedCount: webPushDispatch.deactivatedCount,
          };
        });
      }
    }

    if (sourceDeletedPayloads.length > 0) {
      if (sourceDeletedPayloads.length > 1) {
        jobs.push(async (abortSignal: AbortSignal) => {
          const uniqueNoticeCount = new Set(
            sourceDeletedPayloads.map((payload) => payload.noticeNum),
          ).size;
          const { successCount, failedCount, deactivated, temporaryFailures } =
            await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordSourceDeletedDigestBatch(
                  sourceDeletedPayloads,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: `${sourceDeletedPayloads.length} source-deleted events across ${uniqueNoticeCount} notices`,
                itemType: 'change',
              },
            );

          const webPushDispatch = await this.dispatchToWebPush(
            activePushSubscriptions,
            (subscriptions) =>
              this.webPushNotificationService.sendChangeDigestBatch(
                sourceDeletedPayloads,
                subscriptions,
                { ended: false, sourceDeleted: true },
              ),
          );

          return {
            noticeNum: sourceDeletedPayloads[0].noticeNum,
            subject: `법률안 무효화(삭제) ${sourceDeletedPayloads.length}건 요약`,
            totalWebhooks: activeWebhooks.length,
            totalPushSubscriptions: webPushDispatch.targetCount,
            successCount,
            failedCount,
            deactivated,
            temporaryFailures,
            webPushSuccessCount: webPushDispatch.successCount,
            webPushFailedCount: webPushDispatch.failedCount,
            webPushDeactivatedCount: webPushDispatch.deactivatedCount,
            aggregatedEventCount: sourceDeletedPayloads.length,
            aggregatedNoticeCount: uniqueNoticeCount,
          };
        });
      } else {
        jobs.push(async (abortSignal: AbortSignal) => {
          const payload = sourceDeletedPayloads[0];
          const { successCount, failedCount, deactivated, temporaryFailures } =
            await this.dispatchToWebhooks(
              activeWebhooks,
              (webhooks) =>
                this.notificationService.sendDiscordSourceDeletedBatch(
                  payload,
                  webhooks,
                  abortSignal,
                ),
              {
                itemLabel: `${payload.noticeNum}:${payload.subject}`,
                itemType: 'change',
              },
            );

          const webPushDispatch = await this.dispatchToWebPush(
            activePushSubscriptions,
            (subscriptions) =>
              this.webPushNotificationService.sendChangeBatch(
                payload,
                subscriptions,
              ),
          );

          return {
            noticeNum: payload.noticeNum,
            subject: payload.subject,
            totalWebhooks: activeWebhooks.length,
            totalPushSubscriptions: webPushDispatch.targetCount,
            successCount,
            failedCount,
            deactivated,
            temporaryFailures,
            webPushSuccessCount: webPushDispatch.successCount,
            webPushFailedCount: webPushDispatch.failedCount,
            webPushDeactivatedCount: webPushDispatch.deactivatedCount,
          };
        });
      }
    }

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

  private async dispatchToWebPush(
    subscriptions: WebPushSubscription[],
    send: (
      subscriptions: WebPushSubscription[],
    ) => Promise<WebPushDispatchSummary>,
  ): Promise<WebPushDispatchSummary> {
    if (subscriptions.length === 0) {
      return {
        targetCount: 0,
        successCount: 0,
        failedCount: 0,
        deactivatedCount: 0,
      };
    }

    try {
      return await send(subscriptions);
    } catch (error) {
      this.logger.error(
        `Web push notification dispatch failed: ${(error as Error).message}`,
      );
      return {
        targetCount: subscriptions.length,
        successCount: 0,
        failedCount: subscriptions.length,
        deactivatedCount: 0,
      };
    }
  }
}
