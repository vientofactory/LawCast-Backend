import { APP_CONSTANTS } from '../../../config/app.config';
import { CacheService } from '../../cache/cache.service';
import { NoticeArchiveService } from '../../notice/notice-archive.service';
import { CrawlingCoreService } from '../crawling-core.service';
import { DiscordBridgeService } from '../../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../../utils/logger.utils';

export interface ScreenshotQueueItem {
  num: number;
  contentId: string;
  isDone: boolean;
  retryCount: number;
  nsmBillNo?: string;
}

interface ScreenshotCoordinatorLogger {
  log(message: string): void;
  warn(message: string): void;
}

interface ScreenshotCoordinatorOptions {
  cacheService: CacheService;
  noticeArchiveService: NoticeArchiveService;
  crawlingCoreService: CrawlingCoreService;
  logger: ScreenshotCoordinatorLogger;
  discordBridge?: DiscordBridgeService;
}

export class ArchiveOrchestratorScreenshotCoordinator {
  private isCaptureRunning = false;

  constructor(private readonly options: ScreenshotCoordinatorOptions) {}

  scheduleScreenshots(
    items: Array<{
      num: number;
      contentId: string;
      isDone: boolean;
      nsmBillNo?: string;
    }>,
  ): void {
    if (items.length === 0) return;

    void this.enqueueScreenshots(items).catch((error) => {
      this.options.logger.warn(
        `Failed to enqueue screenshots: ${(error as Error).message}`,
      );
    });
  }

  async handleShutdown(signal?: string): Promise<void> {
    const pending = await this.getScreenshotQueueLength();
    const inProgress = this.isCaptureRunning ? 1 : 0;

    if (pending > 0 || inProgress > 0) {
      this.options.logger.warn(
        `Shutdown (${signal ?? 'unknown'}) with ${pending} screenshot(s) ` +
          `queued and ${inProgress} in progress - they will be skipped.`,
      );
    }

    await this.setScreenshotQueue([]);
  }

  async backfillMissingScreenshots(): Promise<void> {
    try {
      const batchSize = APP_CONSTANTS.SCREENSHOT.BACKFILL_BATCH_SIZE;

      const [missing, nsmMissing] = await Promise.all([
        this.options.noticeArchiveService.getNoticesWithMissingScreenshots(
          batchSize,
        ),
        this.options.noticeArchiveService.getNoticesWithMissingNsmScreenshots(
          batchSize,
        ),
      ]);

      if (missing.length === 0 && nsmMissing.length === 0) {
        LoggerUtils.debugDev(
          'ArchiveOrchestratorService',
          'Screenshot backfill: no missing screenshots found',
        );
        return;
      }

      const total = missing.length + nsmMissing.length;
      this.options.logger.log(
        `Screenshot backfill: queuing ${total} notice(s) with missing screenshots` +
          ` (${missing.length} pal, ${nsmMissing.length} NsmLmSts)`,
      );
      void this.options.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        'ArchiveOrchestratorService',
        `Screenshot backfill: queuing **${total}** notice(s)`,
        { total, pal: missing.length, nsm: nsmMissing.length },
      );

      if (missing.length > 0) {
        this.scheduleScreenshots(missing);
      }
      if (nsmMissing.length > 0) {
        this.scheduleScreenshots(
          nsmMissing.map(({ num }) => ({
            num,
            contentId: '',
            isDone: false,
            nsmBillNo: num.toString(),
          })),
        );
      }
    } catch (error) {
      this.options.logger.warn(
        `Screenshot backfill failed: ${(error as Error).message}`,
      );
    }
  }

  async handleScreenshotBackfill(): Promise<void> {
    const queueLength = await this.getScreenshotQueueLength();
    if (this.isCaptureRunning || queueLength > 0) {
      LoggerUtils.debugDev(
        'ArchiveOrchestratorService',
        'Screenshot backfill cron skipped: capture already running or queue not empty',
      );
      return;
    }
    await this.backfillMissingScreenshots();
  }

  private async drainScreenshotQueue(): Promise<void> {
    if (this.isCaptureRunning) return;
    this.isCaptureRunning = true;

    try {
      for (;;) {
        const queue = await this.getScreenshotQueue();
        if (queue.length === 0) break;

        const notice = queue[0];
        const rest = queue.slice(1);

        const dequeued = await this.setScreenshotQueue(rest);
        if (!dequeued) {
          this.options.logger.warn(
            'Screenshot queue dequeue failed - stopping drain loop for safety',
          );
          break;
        }

        try {
          if (notice.retryCount > 0) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, APP_CONSTANTS.SCREENSHOT.RETRY_DELAY_MS),
            );
          }

          const screenshot = notice.nsmBillNo
            ? await this.options.crawlingCoreService.captureNsmDetailScreenshot(
                notice.nsmBillNo,
              )
            : await this.options.crawlingCoreService.captureContentScreenshot(
                notice.contentId,
                notice.isDone,
              );

          if (screenshot) {
            await this.options.noticeArchiveService.updateScreenshot(
              notice.num,
              screenshot,
              'jpeg',
            );
            LoggerUtils.debug(
              'ArchiveOrchestratorService',
              `Screenshot stored for notice ${notice.num} (${screenshot.length.toLocaleString()} Bytes)`,
            );
          } else {
            this.options.logger.warn(
              `Screenshot permanently skipped for notice ${notice.num}: ` +
                `content exceeds size limit after all compression strategies`,
            );
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await this.requeueOrSkip(notice, message);
        }

        if (notice.nsmBillNo) {
          await new Promise<void>((resolve) =>
            setTimeout(
              resolve,
              APP_CONSTANTS.SCREENSHOT.NSM_INTER_CAPTURE_DELAY_MS,
            ),
          );
        }
      }
    } finally {
      this.isCaptureRunning = false;
    }
  }

  private async requeueOrSkip(
    notice: ScreenshotQueueItem,
    reason: string,
  ): Promise<void> {
    const max = APP_CONSTANTS.SCREENSHOT.MAX_RETRIES;
    const nextAttempt = notice.retryCount + 1;

    if (notice.retryCount < max) {
      const queue = await this.getScreenshotQueue();
      queue.push({ ...notice, retryCount: nextAttempt });
      const queued = await this.setScreenshotQueue(queue);

      if (!queued) {
        this.options.logger.warn(
          `Screenshot retry enqueue failed for notice ${notice.num}: ${reason}`,
        );
        return;
      }

      this.options.logger.warn(
        `Screenshot failed for notice ${notice.num} ` +
          `(attempt ${nextAttempt}/${max + 1}): ${reason} - re-queued`,
      );
      return;
    }

    this.options.logger.warn(
      `Screenshot permanently skipped for notice ${notice.num} ` +
        `after ${max + 1} attempt(s): ${reason} - will retry on next backfill`,
    );
  }

  private async enqueueScreenshots(
    items: Array<{
      num: number;
      contentId: string;
      isDone: boolean;
      nsmBillNo?: string;
    }>,
  ): Promise<void> {
    const queue = await this.getScreenshotQueue();
    const queuedNums = new Set(queue.map((item) => item.num));
    const deduped = items.filter((item) => !queuedNums.has(item.num));

    if (deduped.length === 0) return;

    const availableSlots = Math.max(
      0,
      APP_CONSTANTS.SCREENSHOT.QUEUE.MAX_SIZE - queue.length,
    );

    if (availableSlots === 0) {
      this.options.logger.warn(
        `Screenshot queue at capacity (${queue.length}) - dropping ${deduped.length} enqueue request(s)`,
      );
      return;
    }

    const accepted = deduped.slice(0, availableSlots);
    const dropped = deduped.length - accepted.length;

    queue.push(...accepted.map((item) => ({ ...item, retryCount: 0 })));
    const written = await this.setScreenshotQueue(queue);

    if (!written) {
      this.options.logger.warn(
        `Failed to persist screenshot queue after enqueueing ${deduped.length} notice(s)`,
      );
      return;
    }

    LoggerUtils.debugDev(
      'ArchiveOrchestratorService',
      `Queued ${accepted.length} notice(s) for screenshot capture ` +
        `(${items.length - deduped.length} duplicate(s) skipped, ${dropped} dropped by capacity, ` +
        `queue depth: ${queue.length}, running: ${this.isCaptureRunning})`,
    );

    if (!this.isCaptureRunning) {
      void this.drainScreenshotQueue();
    }
  }

  private async getScreenshotQueue(): Promise<ScreenshotQueueItem[]> {
    const queue = await this.options.cacheService.getObject<
      ScreenshotQueueItem[]
    >(APP_CONSTANTS.SCREENSHOT.QUEUE.KEY);

    return Array.isArray(queue) ? queue : [];
  }

  private async getScreenshotQueueLength(): Promise<number> {
    const queue = await this.getScreenshotQueue();
    return queue.length;
  }

  private async setScreenshotQueue(
    queue: ScreenshotQueueItem[],
  ): Promise<boolean> {
    if (queue.length === 0) {
      return this.options.cacheService.deleteKey(
        APP_CONSTANTS.SCREENSHOT.QUEUE.KEY,
      );
    }

    return this.options.cacheService.setObject(
      APP_CONSTANTS.SCREENSHOT.QUEUE.KEY,
      queue,
      APP_CONSTANTS.SCREENSHOT.QUEUE.TTL_SECONDS,
    );
  }
}
