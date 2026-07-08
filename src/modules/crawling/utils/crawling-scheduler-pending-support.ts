import { type INsmBillItem } from 'pal-crawl';
import { type CachedNotice } from '../../../types/cache.types';
import { APP_CONSTANTS } from '../../../config/app.config';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { mapConcurrently } from '../../../utils/concurrency.utils';
import { type ArchiveOrchestratorService } from '../archive-orchestrator.service';
import { type CacheService } from '../../cache/cache.service';
import { CrawlingCoreService } from '../crawling-core.service';
import { type NoticeArchiveService } from '../../notice/notice-archive.service';
import { type NotificationOrchestratorService } from '../../notification/notification-orchestrator.service';
import { type SummaryGenerationService } from '../summary-generation.service';
import { type DiscordBridgeService } from '../../discord-bridge/discord-bridge.service';
import { type CrawlingSchedulerProposalRetry } from './crawling-scheduler-proposal-retry';

export interface PendingWorkflowDeps {
  isInitialized: boolean;
  logger: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string, trace?: unknown): void;
  };
  discordBridge?: DiscordBridgeService;
  crawlingCoreService: CrawlingCoreService;
  archiveOrchestratorService: ArchiveOrchestratorService;
  notificationOrchestratorService: NotificationOrchestratorService;
  summaryGenerationService: SummaryGenerationService;
  noticeArchiveService: NoticeArchiveService;
  cacheService: CacheService;
  proposalRetrySupport: CrawlingSchedulerProposalRetry;
  runBackgroundTask(taskName: string, task: () => Promise<void>): void;
  isRetryableNetworkError(error: unknown): boolean;
}

export async function handlePendingCronInternal(
  deps: PendingWorkflowDeps,
  pendingCrawlMaxRetries: number,
  pendingCrawlRetryBaseMs: number,
): Promise<void> {
  if (!deps.isInitialized) {
    return;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= pendingCrawlMaxRetries; attempt++) {
    try {
      await performPendingBillsCrawlInternal(deps);
      return;
    } catch (error) {
      lastError = error;
      const canRetry =
        attempt < pendingCrawlMaxRetries && deps.isRetryableNetworkError(error);

      if (!canRetry) {
        break;
      }

      const backoffMs = pendingCrawlRetryBaseMs * 2 ** attempt;
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  deps.logger.error('Error during pending bills crawl', lastError);
  void deps.discordBridge?.logEvent(
    BridgeLogLevel.ERROR,
    'CrawlingSchedulerService',
    `Pending bills crawl failed: ${(lastError as Error).message}`,
  );
}

export async function performPendingBillsCrawlInternal(
  deps: PendingWorkflowDeps,
): Promise<void> {
  const rawItemMap = new Map<number, INsmBillItem>();
  const pendingNotices: CachedNotice[] = [];

  for await (const page of deps.crawlingCoreService.getAllNsmPendingPages(
    {},
    { delayMs: APP_CONSTANTS.ARCHIVE_SYNC.NSM_CRAWLER_DELAY_MS },
  )) {
    for (const item of page.items ?? []) {
      const notice = CrawlingCoreService.nsmBillToCachedNotice(item);
      if (!rawItemMap.has(notice.num)) {
        rawItemMap.set(notice.num, item);
        pendingNotices.push(notice);
      }
    }
  }

  if (pendingNotices.length === 0) return;

  const newPendingNotices =
    await deps.archiveOrchestratorService.filterAlreadyArchivedNotices(
      pendingNotices,
    );

  const newPendingNumSet = new Set(newPendingNotices.map((n) => n.num));
  const existingPendingItems = pendingNotices
    .filter((notice) => !newPendingNumSet.has(notice.num))
    .map((notice) => rawItemMap.get(notice.num))
    .filter((item): item is INsmBillItem => item !== undefined)
    .slice(0, APP_CONSTANTS.ARCHIVE_SYNC.SUMMARY_BACKFILL_BATCH_SIZE);

  if (existingPendingItems.length > 0) {
    deps.runBackgroundTask('refresh-existing-pending-bills', async () => {
      await refreshExistingPendingBillsInBackgroundInternal(
        deps,
        existingPendingItems,
      );
    });
  }

  if (newPendingNotices.length === 0) return;

  deps.logger.log(
    `Found ${newPendingNotices.length} new pending bill(s) from NsmLmSts`,
  );
  void deps.discordBridge?.logEvent(
    BridgeLogLevel.LOG,
    'CrawlingSchedulerService',
    `Found **${newPendingNotices.length}** new pending bill(s) from NsmLmSts`,
    {
      subjects: newPendingNotices.slice(0, 5).map((n) => n.subject),
      total: newPendingNotices.length,
    },
  );

  const newPendingItems = newPendingNotices
    .map((n) => rawItemMap.get(n.num))
    .filter((item): item is INsmBillItem => item !== undefined);

  deps.runBackgroundTask('process-pending-bills', async () => {
    try {
      await processPendingBillsInBackgroundInternal(
        deps,
        newPendingItems,
        newPendingNotices,
      );
    } catch (error) {
      deps.logger.error(
        'Background processing for pending bills failed:',
        error,
      );
      void deps.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        'CrawlingSchedulerService',
        `Pending bills background processing failed: ${(error as Error).message}`,
      );
    }
  });
}

export async function refreshExistingPendingBillsInBackgroundInternal(
  deps: PendingWorkflowDeps,
  items: INsmBillItem[],
): Promise<void> {
  const refreshed = await deps.archiveOrchestratorService.archiveNsmBillItems(
    items,
    { reason: 'existing-pending-recompare' },
  );

  if (refreshed.length > 0) {
    deps.logger.log(
      `Periodic NSM re-compare scanned ${refreshed.length} archived pending bill(s)`,
    );
  }
}

export async function processPendingBillsInBackgroundInternal(
  deps: PendingWorkflowDeps,
  newPendingItems: INsmBillItem[],
  newPendingNotices: CachedNotice[],
): Promise<void> {
  let archivedNotices: CachedNotice[] = [];
  try {
    archivedNotices = await deps.archiveOrchestratorService.archiveNsmBillItems(
      newPendingItems,
      { reason: 'new-pending-bills' },
    );
  } catch (error) {
    deps.logger.error(
      `Archive stage failed for pending bills, proceeding with cache and notifications: ${(error as Error).message}`,
    );
    void deps.discordBridge?.logEvent(
      BridgeLogLevel.ERROR,
      'CrawlingSchedulerService',
      `Pending bills archive stage failed: ${(error as Error).message}`,
    );
  }

  const noticesWithReason = archivedNotices.filter((n) =>
    n.proposalReason?.trim(),
  );
  const noticesWithoutReason = archivedNotices.filter(
    (n) => !n.proposalReason?.trim(),
  );

  const noticesWithoutReasonForNotification: CachedNotice[] =
    noticesWithoutReason.map((notice) => ({
      ...notice,
      aiSummary: null,
      aiSummaryStatus: 'not_supported' as const,
    }));

  if (noticesWithoutReasonForNotification.length > 0) {
    void deps.notificationOrchestratorService
      .sendNotifications(noticesWithoutReasonForNotification)
      .catch((error) => {
        deps.logger.error(
          'Notification dispatch for pending bills without proposalReason failed:',
          error,
        );
        void deps.discordBridge?.logEvent(
          BridgeLogLevel.ERROR,
          'CrawlingSchedulerService',
          'Notification dispatch failed for pending bills without proposalReason',
          {
            count: noticesWithoutReasonForNotification.length,
            billNos: noticesWithoutReasonForNotification.map(
              (notice) => notice.num,
            ),
            proposalReasonState: 'missing',
            notificationMode: 'immediate',
            guidanceIncluded: true,
          },
        );
      });
  }

  if (noticesWithoutReason.length > 0) {
    deps.logger.log(
      `${noticesWithoutReason.length} pending bill(s) archived without proposalReason`,
    );
    void deps.discordBridge?.logEvent(
      BridgeLogLevel.WARN,
      'CrawlingSchedulerService',
      `**${noticesWithoutReason.length}** pending bill(s) missing proposalReason`,
      {
        nums: noticesWithoutReason.map((n) => n.num),
        immutableSnapshot: true,
      },
    );

    const billNoByNum = new Map<number, string>();
    for (const item of newPendingItems) {
      const parsed = Number.parseInt(item.billNo, 10);
      if (!Number.isNaN(parsed) && item.billNo?.trim()) {
        billNoByNum.set(parsed, item.billNo.trim());
      }
    }

    for (const notice of noticesWithoutReason) {
      await deps.proposalRetrySupport.enqueue(notice, {
        billNo: billNoByNum.get(notice.num) ?? null,
      });
    }

    deps.proposalRetrySupport.drainInBackground();
  }

  const summaryBase =
    noticesWithReason.length > 0
      ? noticesWithReason
      : archivedNotices.length === 0
        ? newPendingNotices
        : [];

  const concurrency = APP_CONSTANTS.CRAWLING.SUMMARY_CONCURRENCY;
  const noticesWithSummary =
    summaryBase.length > 0
      ? await mapConcurrently(summaryBase, concurrency, async (notice) => {
          try {
            const result =
              await deps.summaryGenerationService.generateSummaryForNotice(
                notice,
              );
            return { ...notice, ...result };
          } catch {
            return {
              ...notice,
              aiSummary: null,
              aiSummaryStatus: 'not_requested' as const,
            };
          }
        })
      : [];

  if (noticesWithReason.length > 0 && noticesWithSummary.length > 0) {
    await Promise.allSettled(
      noticesWithSummary
        .filter(
          (n) => (n.aiSummaryStatus ?? 'not_requested') !== 'not_requested',
        )
        .map((n) =>
          deps.noticeArchiveService.updateSummaryStateByNoticeNum(
            n.num,
            n.aiSummary ?? null,
            n.aiSummaryStatus ?? 'not_requested',
          ),
        ),
    );
  }

  const allForCache: CachedNotice[] = [
    ...noticesWithSummary,
    ...noticesWithoutReasonForNotification,
  ];

  if (allForCache.length > 0) {
    try {
      const freshCache = await deps.cacheService.getRecentNotices(
        APP_CONSTANTS.CACHE.MAX_SIZE,
      );
      const newNums = new Set(allForCache.map((n) => n.num));
      const merged = [
        ...allForCache,
        ...freshCache.filter((n) => !newNums.has(n.num)),
      ];
      await deps.cacheService.updateCache(merged);
    } catch (error) {
      deps.logger.warn(
        `Cache update for pending bills failed: ${(error as Error).message}`,
      );
    }
  }

  if (noticesWithSummary.length > 0 && noticesWithReason.length > 0) {
    void deps.notificationOrchestratorService
      .sendNotifications(noticesWithSummary)
      .catch((error) => {
        deps.logger.error(
          'Notification dispatch for pending bills failed:',
          error,
        );
      });
  }
}
