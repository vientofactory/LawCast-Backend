import { type CachedNotice } from '../../../types/cache.types';
import { APP_CONSTANTS } from '../../../config/app.config';
import { CacheService } from '../../cache/cache.service';
import { ArchiveOrchestratorService } from '../archive-orchestrator.service';
import { SummaryGenerationService } from '../summary-generation.service';
import { NotificationOrchestratorService } from '../../notification/notification-orchestrator.service';
import { NoticeArchiveService } from '../../notice/notice-archive.service';
import { DiscordBridgeService } from '../../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../../utils/logger.utils';
import {
  AI_SUMMARY_STATUS,
  normalizeAttemptedSummaryStatus,
} from './ai-summary-status.utils';

const {
  NSM_REASON_RETRY_MAX_ATTEMPTS,
  NSM_REASON_RETRY_MAX_AGE_MS,
  PROPOSAL_REASON_RETRY_QUEUE,
} = APP_CONSTANTS.ARCHIVE_SYNC;

interface ProposalReasonRetryItem {
  notice: CachedNotice;
  billNo: string;
  retryCount: number;
  queuedAt: Date;
}

interface ProposalReasonRetryQueueRecord {
  notice: CachedNotice;
  billNo: string;
  retryCount: number;
  queuedAtIso: string;
}

interface ProposalRetryLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

interface ProposalRetryOptions {
  cacheService: CacheService;
  archiveOrchestratorService: ArchiveOrchestratorService;
  summaryGenerationService: SummaryGenerationService;
  notificationOrchestratorService: NotificationOrchestratorService;
  noticeArchiveService: NoticeArchiveService;
  logger: ProposalRetryLogger;
  discordBridge?: DiscordBridgeService;
}

export class CrawlingSchedulerProposalRetry {
  private isRunning = false;
  private rerunRequested = false;

  constructor(private readonly options: ProposalRetryOptions) {}

  async enqueue(notice: CachedNotice): Promise<void> {
    const queue = await this.getQueue();

    if (queue.length >= PROPOSAL_REASON_RETRY_QUEUE.MAX_SIZE) {
      this.options.logger.warn(
        `proposalReason retry: queue at capacity (${queue.length}) - sending fallback notification for bill ${notice.num}`,
      );
      void this.options.notificationOrchestratorService
        .sendNotifications([
          {
            ...notice,
            aiSummary: null,
            aiSummaryStatus: 'not_supported' as const,
          },
        ])
        .catch(() => undefined);
      return;
    }

    const alreadyQueued = queue.some((item) => item.notice.num === notice.num);
    if (alreadyQueued) return;

    queue.push({
      notice,
      billNo: notice.num.toString(),
      retryCount: 0,
      queuedAt: new Date(),
    });

    const written = await this.setQueue(queue);
    if (!written) {
      this.options.logger.warn(
        `proposalReason retry: failed to persist queue after enqueueing bill ${notice.num}`,
      );
    }

    LoggerUtils.debugDev(
      'CrawlingSchedulerService',
      `proposalReason retry: enqueued bill ${notice.num} (queue size: ${queue.length})`,
    );
  }

  drainInBackground(): void {
    if (this.isRunning) {
      this.rerunRequested = true;
      return;
    }

    this.isRunning = true;
    void this.drain()
      .catch((error) => {
        this.options.logger.error(
          `proposalReason retry queue drain failed: ${(error as Error).message}`,
        );
      })
      .finally(() => {
        this.isRunning = false;
        if (!this.rerunRequested) {
          return;
        }

        this.rerunRequested = false;
        this.drainInBackground();
      });
  }

  async getQueueLength(): Promise<number> {
    const queue = await this.getQueue();
    return queue.length;
  }

  private async drain(): Promise<void> {
    const queue = await this.getQueue();
    if (queue.length === 0) return;

    const now = Date.now();
    let queueDirty = false;

    const evicted: ProposalReasonRetryItem[] = [];
    let index = queue.length;
    while (index--) {
      const item = queue[index];
      const expired =
        item.retryCount >= NSM_REASON_RETRY_MAX_ATTEMPTS ||
        now - item.queuedAt.getTime() > NSM_REASON_RETRY_MAX_AGE_MS;
      if (expired) {
        evicted.push(item);
        queue.splice(index, 1);
        queueDirty = true;
      }
    }

    if (evicted.length > 0) {
      this.options.logger.warn(
        `proposalReason retry: evicting ${evicted.length} bill(s) after exhausting retries - sending fallback notifications`,
      );
      void this.options.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        'CrawlingSchedulerService',
        `proposalReason retry: evicting **${evicted.length}** bill(s) - sending notification without summary`,
        { nums: evicted.map((item) => item.notice.num) },
      );
      void this.options.notificationOrchestratorService
        .sendNotifications(
          evicted.map((item) => ({
            ...item.notice,
            aiSummary: null,
            aiSummaryStatus: 'not_supported' as const,
          })),
        )
        .catch(() => undefined);
    }

    if (queue.length === 0) {
      if (queueDirty) {
        await this.setQueue(queue);
      }
      return;
    }

    this.options.logger.log(
      `proposalReason retry: processing ${queue.length} queued bill(s)`,
    );

    const resolved: CachedNotice[] = [];

    for (let idx = 0; idx < queue.length; idx++) {
      const item = queue[idx];

      if (idx > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, APP_CONSTANTS.ARCHIVE_SYNC.NSM_CRAWLER_DELAY_MS),
        );
      }

      const proposalReason =
        await this.options.archiveOrchestratorService.fetchAndUpdateProposalReason(
          item.notice.num,
          item.billNo,
          item.notice.link,
        );

      if (!proposalReason) {
        item.retryCount++;
        queueDirty = true;
        this.options.logger.warn(
          `proposalReason retry: still empty for bill ${item.billNo} ` +
            `(attempt ${item.retryCount}/${NSM_REASON_RETRY_MAX_ATTEMPTS})`,
        );
        continue;
      }

      const enriched: CachedNotice = { ...item.notice, proposalReason };

      let noticeWithSummary: CachedNotice;
      try {
        const summaryResult =
          await this.options.summaryGenerationService.generateSummaryForNotice(
            enriched,
          );
        const normalizedStatus = normalizeAttemptedSummaryStatus(
          summaryResult.aiSummaryStatus,
          this.options.summaryGenerationService.isAiSummaryEnabled(),
        );

        noticeWithSummary = {
          ...enriched,
          aiSummary: summaryResult.aiSummary,
          aiSummaryStatus: normalizedStatus,
        };
      } catch (error) {
        this.options.logger.warn(
          `proposalReason retry: summary generation failed for bill ${item.billNo}: ${(error as Error).message}`,
        );
        noticeWithSummary = {
          ...enriched,
          aiSummary: null,
          aiSummaryStatus: AI_SUMMARY_STATUS.UNAVAILABLE,
        };
      }

      await this.options.noticeArchiveService
        .updateSummaryStateByNoticeNum(
          noticeWithSummary.num,
          noticeWithSummary.aiSummary ?? null,
          noticeWithSummary.aiSummaryStatus ?? 'not_requested',
        )
        .catch((error) => {
          this.options.logger.warn(
            `Failed to persist summary for bill ${item.billNo}: ${(error as Error).message}`,
          );
        });

      resolved.push(noticeWithSummary);
      queue.splice(idx, 1);
      queueDirty = true;
      idx--;

      this.options.logger.log(
        `proposalReason retry: resolved bill ${item.billNo} after ${item.retryCount + 1} attempt(s)`,
      );
      void this.options.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        'CrawlingSchedulerService',
        `proposalReason retry: resolved bill **${item.billNo}**`,
        { billNo: item.billNo, attempts: item.retryCount + 1 },
      );
    }

    if (queueDirty) {
      await this.setQueue(queue);
    }

    if (resolved.length === 0) return;

    try {
      const freshCache = await this.options.cacheService.getRecentNotices(
        APP_CONSTANTS.CACHE.MAX_SIZE,
      );
      const resolvedMap = new Map(
        resolved.map((notice) => [notice.num, notice]),
      );
      const existingNums = new Set(freshCache.map((notice) => notice.num));
      const merged = [
        ...freshCache.map((notice) => resolvedMap.get(notice.num) ?? notice),
        ...resolved.filter((notice) => !existingNums.has(notice.num)),
      ];
      await this.options.cacheService.updateCache(merged);
    } catch (error) {
      this.options.logger.warn(
        `Cache update after proposalReason retry failed: ${(error as Error).message}`,
      );
    }

    void this.options.notificationOrchestratorService
      .sendNotifications(resolved)
      .catch((error) => {
        this.options.logger.error(
          `Notification dispatch after proposalReason retry failed: ${(error as Error).message}`,
        );
      });

    void this.options.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      'CrawlingSchedulerService',
      `proposalReason retry: **${resolved.length}** resolved, **${queue.length}** still pending`,
      {
        resolved: resolved.length,
        pending: queue.length,
      },
    );
  }

  private toQueueRecord(
    item: ProposalReasonRetryItem,
  ): ProposalReasonRetryQueueRecord {
    return {
      notice: item.notice,
      billNo: item.billNo,
      retryCount: item.retryCount,
      queuedAtIso: item.queuedAt.toISOString(),
    };
  }

  private fromQueueRecord(
    item: ProposalReasonRetryQueueRecord,
  ): ProposalReasonRetryItem | null {
    const queuedAt = new Date(item.queuedAtIso);
    if (Number.isNaN(queuedAt.getTime())) {
      return null;
    }

    return {
      notice: item.notice,
      billNo: item.billNo,
      retryCount: item.retryCount,
      queuedAt,
    };
  }

  private async getQueue(): Promise<ProposalReasonRetryItem[]> {
    const stored = await this.options.cacheService.getObject<
      ProposalReasonRetryQueueRecord[]
    >(PROPOSAL_REASON_RETRY_QUEUE.KEY);

    if (!Array.isArray(stored) || stored.length === 0) {
      return [];
    }

    const queue: ProposalReasonRetryItem[] = [];
    for (const row of stored) {
      const restored = this.fromQueueRecord(row);
      if (restored) {
        queue.push(restored);
      }
    }

    return queue;
  }

  private async setQueue(queue: ProposalReasonRetryItem[]): Promise<boolean> {
    if (queue.length === 0) {
      return this.options.cacheService.deleteKey(
        PROPOSAL_REASON_RETRY_QUEUE.KEY,
      );
    }

    return this.options.cacheService.setObject(
      PROPOSAL_REASON_RETRY_QUEUE.KEY,
      queue.map((item) => this.toQueueRecord(item)),
      PROPOSAL_REASON_RETRY_QUEUE.TTL_SECONDS,
    );
  }
}
