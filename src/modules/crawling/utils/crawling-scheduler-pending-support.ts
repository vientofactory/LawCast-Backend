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
import { delayMs } from '../../../utils/async-delay.utils';
import { logAndBridge } from '../../../utils/bridge-log.utils';

interface PendingErrorDiagnostics {
  message: string;
  name?: string;
  stack?: string;
  statusCode?: number;
  statusText?: string;
  responseUrl?: string;
}

function toPendingErrorDiagnostics(error: unknown): PendingErrorDiagnostics {
  const fallbackMessage =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');

  const details: PendingErrorDiagnostics = {
    message: fallbackMessage,
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  };

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      response?: {
        status?: number;
        statusText?: string;
        url?: string;
      };
      status?: number;
      statusText?: string;
      responseUrl?: string;
      url?: string;
    };

    const statusCode =
      typeof candidate.response?.status === 'number'
        ? candidate.response.status
        : typeof candidate.status === 'number'
          ? candidate.status
          : undefined;
    const statusText =
      typeof candidate.response?.statusText === 'string'
        ? candidate.response.statusText
        : typeof candidate.statusText === 'string'
          ? candidate.statusText
          : undefined;
    const responseUrl =
      typeof candidate.response?.url === 'string'
        ? candidate.response.url
        : typeof candidate.responseUrl === 'string'
          ? candidate.responseUrl
          : typeof candidate.url === 'string'
            ? candidate.url
            : undefined;

    details.statusCode = statusCode;
    details.statusText = statusText;
    details.responseUrl = responseUrl;
  }

  return details;
}

function buildPendingErrorLocationHint(
  diagnostics: PendingErrorDiagnostics,
): string {
  if (diagnostics.responseUrl) {
    return diagnostics.statusCode
      ? `${diagnostics.responseUrl} (status=${diagnostics.statusCode}${diagnostics.statusText ? ` ${diagnostics.statusText}` : ''})`
      : diagnostics.responseUrl;
  }

  if (diagnostics.statusCode) {
    return `${diagnostics.statusCode}${diagnostics.statusText ? ` ${diagnostics.statusText}` : ''}`;
  }

  return 'unknown-location';
}

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
  let lastAttempt = 0;
  for (let attempt = 0; attempt <= pendingCrawlMaxRetries; attempt++) {
    try {
      await performPendingBillsCrawlInternal(deps);
      return;
    } catch (error) {
      lastError = error;
      lastAttempt = attempt;
      const diagnostics = toPendingErrorDiagnostics(error);
      const canRetry =
        attempt < pendingCrawlMaxRetries && deps.isRetryableNetworkError(error);

      logAndBridge({
        logger: deps.logger,
        method: canRetry ? 'warn' : 'error',
        message: `Pending bills crawl attempt ${attempt + 1}/${pendingCrawlMaxRetries + 1} failed at ${buildPendingErrorLocationHint(diagnostics)}: ${diagnostics.message}`,
        loggerArgs: diagnostics.stack ? [diagnostics.stack] : [error],
        context: 'CrawlingSchedulerService',
        discordBridge: deps.discordBridge,
        bridgeMessage: `Pending bills crawl attempt ${attempt + 1}/${pendingCrawlMaxRetries + 1} failed (${diagnostics.statusCode ?? 'no-status'}) at ${diagnostics.responseUrl ?? 'unknown-location'}`,
        metadata: {
          attempt: attempt + 1,
          maxAttempts: pendingCrawlMaxRetries + 1,
          willRetry: canRetry,
          errorName: diagnostics.name,
          errorMessage: diagnostics.message,
          statusCode: diagnostics.statusCode,
          statusText: diagnostics.statusText,
          responseUrl: diagnostics.responseUrl,
        },
      });

      if (!canRetry) {
        break;
      }

      const backoffMs = pendingCrawlRetryBaseMs * 2 ** attempt;
      await delayMs(backoffMs);
    }
  }

  const diagnostics = toPendingErrorDiagnostics(lastError);

  logAndBridge({
    logger: deps.logger,
    method: 'error',
    message: `Error during pending bills crawl after ${lastAttempt + 1}/${pendingCrawlMaxRetries + 1} attempts (last location: ${buildPendingErrorLocationHint(diagnostics)}): ${diagnostics.message}`,
    loggerArgs: diagnostics.stack ? [diagnostics.stack] : [lastError],
    context: 'CrawlingSchedulerService',
    discordBridge: deps.discordBridge,
    bridgeMessage:
      `Pending bills crawl failed: ${diagnostics.message}` +
      (diagnostics.statusCode
        ? ` (status=${diagnostics.statusCode}${diagnostics.statusText ? ` ${diagnostics.statusText}` : ''})`
        : '') +
      (diagnostics.responseUrl ? ` @ ${diagnostics.responseUrl}` : ''),
    metadata: {
      attempts: lastAttempt + 1,
      maxAttempts: pendingCrawlMaxRetries + 1,
      errorName: diagnostics.name,
      errorMessage: diagnostics.message,
      statusCode: diagnostics.statusCode,
      statusText: diagnostics.statusText,
      responseUrl: diagnostics.responseUrl,
    },
  });
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

  logAndBridge({
    logger: deps.logger,
    method: 'log',
    message: `Found ${newPendingNotices.length} new pending bill(s) from NsmLmSts`,
    context: 'CrawlingSchedulerService',
    discordBridge: deps.discordBridge,
    bridgeMessage: `Found **${newPendingNotices.length}** new pending bill(s) from NsmLmSts`,
    metadata: {
      subjects: newPendingNotices.slice(0, 5).map((n) => n.subject),
      total: newPendingNotices.length,
    },
  });

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
      logAndBridge({
        logger: deps.logger,
        method: 'error',
        message: 'Background processing for pending bills failed:',
        loggerArgs: [error],
        context: 'CrawlingSchedulerService',
        discordBridge: deps.discordBridge,
        bridgeMessage: `Pending bills background processing failed: ${(error as Error).message}`,
      });
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
    logAndBridge({
      logger: deps.logger,
      method: 'error',
      message: `Archive stage failed for pending bills, proceeding with cache and notifications: ${(error as Error).message}`,
      context: 'CrawlingSchedulerService',
      discordBridge: deps.discordBridge,
      bridgeMessage: `Pending bills archive stage failed: ${(error as Error).message}`,
    });
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
        logAndBridge({
          logger: deps.logger,
          method: 'error',
          message:
            'Notification dispatch for pending bills without proposalReason failed:',
          loggerArgs: [error],
          context: 'CrawlingSchedulerService',
          discordBridge: deps.discordBridge,
          bridgeMessage:
            'Notification dispatch failed for pending bills without proposalReason',
          metadata: {
            count: noticesWithoutReasonForNotification.length,
            billNos: noticesWithoutReasonForNotification.map(
              (notice) => notice.num,
            ),
            proposalReasonState: 'missing',
            notificationMode: 'immediate',
            guidanceIncluded: true,
          },
        });
      });
  }

  if (noticesWithoutReason.length > 0) {
    logAndBridge({
      logger: deps.logger,
      method: 'log',
      message: `${noticesWithoutReason.length} pending bill(s) archived without proposalReason`,
      context: 'CrawlingSchedulerService',
      discordBridge: deps.discordBridge,
      bridgeLevel: BridgeLogLevel.WARN,
      bridgeMessage: `**${noticesWithoutReason.length}** pending bill(s) missing proposalReason`,
      metadata: {
        nums: noticesWithoutReason.map((n) => n.num),
        immutableSnapshot: true,
      },
    });

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
