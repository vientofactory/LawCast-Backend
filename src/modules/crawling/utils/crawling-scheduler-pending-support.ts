import { type INsmBillItem } from 'pal-crawl';
import { AISummaryStatus, type CachedNotice } from '../../../types/cache.types';
import { APP_CONSTANTS } from '../../../config/app.config';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { mapConcurrently } from '../../../utils/concurrency.utils';
import {
  NsmArchiveReason,
  type ArchiveOrchestratorService,
} from '../archive-orchestrator.service';
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
  crawlPhase?: string;
  crawlPageIndex?: number;
  crawlBillNo?: string;
}

/**
 * pal-crawl's HttpClient throws plain Error objects like:
 *   "Invalid response: 307 Temporary Redirect"
 * without any structured properties (statusCode, url, etc.).
 * We extract the numeric status code from the message as a fallback.
 */
function parseStatusCodeFromMessage(message: string): number | undefined {
  const match = message.match(/Invalid\s+response:\s*(\d{3})\b/);
  if (match?.[1]) {
    const code = Number.parseInt(match[1], 10);
    if (code >= 100 && code < 600) return code;
  }
  return undefined;
}

function toPendingErrorDiagnostics(error: unknown): PendingErrorDiagnostics {
  const fallbackMessage =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');

  // NsmCrawlContextError stores the original pal-crawl error as `cause`;
  // prefer its stack trace for debugging if the wrapper's own stack is less
  // informative.
  const causeStack =
    error instanceof Error &&
    typeof (error as { cause?: unknown }).cause === 'object' &&
    (error as { cause?: unknown }).cause instanceof Error
      ? ((error as unknown as { cause: Error }).cause as Error).stack
      : undefined;

  const details: PendingErrorDiagnostics = {
    message: fallbackMessage,
    name: error instanceof Error ? error.name : undefined,
    stack: causeStack ?? (error instanceof Error ? error.stack : undefined),
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
      crawlPhase?: string;
      crawlPageIndex?: number;
      crawlBillNo?: string;
      cause?: unknown;
    };

    // Also check the cause chain for crawl context fields
    const cause =
      typeof candidate.cause === 'object' && candidate.cause !== null
        ? (candidate.cause as {
            crawlPhase?: string;
            crawlPageIndex?: number;
            crawlBillNo?: string;
          })
        : undefined;

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

    details.statusCode =
      statusCode ?? parseStatusCodeFromMessage(fallbackMessage);
    details.statusText = statusText;
    details.responseUrl = responseUrl;
    details.crawlPhase = candidate.crawlPhase ?? cause?.crawlPhase;
    details.crawlPageIndex = candidate.crawlPageIndex ?? cause?.crawlPageIndex;
    details.crawlBillNo = candidate.crawlBillNo ?? cause?.crawlBillNo;
  } else {
    details.statusCode = parseStatusCodeFromMessage(fallbackMessage);
  }

  return details;
}

function buildPendingErrorLocationHint(
  diagnostics: PendingErrorDiagnostics,
): string {
  const statusPart = diagnostics.statusCode
    ? `status=${diagnostics.statusCode}${diagnostics.statusText ? ` ${diagnostics.statusText}` : ''}`
    : undefined;

  const phasePart = diagnostics.crawlPhase
    ? `phase=${diagnostics.crawlPhase}`
    : undefined;

  const pagePart =
    diagnostics.crawlPageIndex !== undefined
      ? `page=${diagnostics.crawlPageIndex}`
      : undefined;

  const billPart = diagnostics.crawlBillNo
    ? `bill=${diagnostics.crawlBillNo}`
    : undefined;

  const parts = [
    diagnostics.responseUrl,
    statusPart,
    phasePart,
    pagePart,
    billPart,
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(', ');
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
        bridgeMessage: `Pending bills crawl attempt ${attempt + 1}/${pendingCrawlMaxRetries + 1} failed (${diagnostics.statusCode ?? 'no-status'}) at ${diagnostics.responseUrl ?? diagnostics.crawlPhase ?? 'unknown-location'}`,
        metadata: {
          attempt: attempt + 1,
          maxAttempts: pendingCrawlMaxRetries + 1,
          willRetry: canRetry,
          errorName: diagnostics.name,
          errorMessage: diagnostics.message,
          statusCode: diagnostics.statusCode,
          statusText: diagnostics.statusText,
          responseUrl: diagnostics.responseUrl,
          crawlPhase: diagnostics.crawlPhase,
          crawlPageIndex: diagnostics.crawlPageIndex,
          crawlBillNo: diagnostics.crawlBillNo,
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
      (diagnostics.responseUrl
        ? ` @ ${diagnostics.responseUrl}`
        : diagnostics.crawlPhase
          ? ` @ ${diagnostics.crawlPhase}${diagnostics.crawlPageIndex !== undefined ? ` page ${diagnostics.crawlPageIndex}` : ''}`
          : ''),
    metadata: {
      attempts: lastAttempt + 1,
      maxAttempts: pendingCrawlMaxRetries + 1,
      errorName: diagnostics.name,
      errorMessage: diagnostics.message,
      statusCode: diagnostics.statusCode,
      statusText: diagnostics.statusText,
      responseUrl: diagnostics.responseUrl,
      crawlPhase: diagnostics.crawlPhase,
      crawlPageIndex: diagnostics.crawlPageIndex,
      crawlBillNo: diagnostics.crawlBillNo,
    },
  });
}

export async function performPendingBillsCrawlInternal(
  deps: PendingWorkflowDeps,
): Promise<void> {
  const rawItemMap = new Map<number, INsmBillItem>();
  const nsmNotices: CachedNotice[] = [];
  const pendingCandidateNums = new Set<number>();
  const query = { pageSize: APP_CONSTANTS.ARCHIVE_SYNC.CRAWLER_PAGE_UNIT };
  const crawlOptions = {
    delayMs: APP_CONSTANTS.ARCHIVE_SYNC.NSM_CRAWLER_DELAY_MS,
    concurrency: APP_CONSTANTS.ARCHIVE_SYNC.NSM_CRAWLER_CONCURRENCY,
  };
  const isPendingLike = (item: INsmBillItem): boolean =>
    item.progressStatus?.trim() === '발의';
  const collectPageItems = (
    items: INsmBillItem[] | null | undefined,
    source: 'all' | 'pending',
  ) => {
    for (const item of items ?? []) {
      const notice = CrawlingCoreService.nsmBillToCachedNotice(item);
      if (!rawItemMap.has(notice.num)) {
        rawItemMap.set(notice.num, item);
        nsmNotices.push(notice);
      }
      if (source === 'pending' || isPendingLike(item)) {
        pendingCandidateNums.add(notice.num);
      }
    }
  };

  // Wrap scans in try-catch so that subsequent phases (new bill archive)
  // can still run even if the NSM crawl encounters non-retryable errors
  // (e.g. Waitingroom 307 after Puppeteer fallback).  Retryable network
  // errors (ECONNRESET) are re-thrown so the outer retry loop in
  // handlePendingCronInternal can handle them.
  let scanError: unknown = null;
  try {
    for await (const page of deps.crawlingCoreService.getAllNsmPages(
      query,
      crawlOptions,
    )) {
      collectPageItems(page.items ?? [], 'all');
    }

    for await (const page of deps.crawlingCoreService.getAllNsmPendingPages(
      query,
      crawlOptions,
    )) {
      collectPageItems(page.items ?? [], 'pending');
    }
  } catch (error) {
    if (deps.isRetryableNetworkError(error)) {
      throw error;
    }
    scanError = error;
    deps.logger.warn(
      `NSM pending crawl scan error (continuing with partial data): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ── NSM source-missing detection (cron path) ──────────────────────
  // Only run when the full list crawl completed without errors.  A
  // partial scan means some pages were never visited, so bills on those
  // pages would be absent from rawItemMap and falsely marked as
  // source_deleted.  Missing bills will be caught on the next successful
  // crawl run.
  if (scanError) {
    logAndBridge({
      logger: deps.logger,
      method: 'warn',
      message: `Skipping NSM source-missing detection: scan error occurred (${rawItemMap.size} items collected, scan incomplete)`,
      context: 'CrawlingSchedulerService',
      discordBridge: deps.discordBridge,
      bridgeMessage: `Skipping NSM source-missing detection: scan error occurred (**${rawItemMap.size}** items collected, scan incomplete)`,
    });
  } else if (rawItemMap.size > 0) {
    const sourceDeletedCount =
      await deps.noticeArchiveService.markSourceDeletedByMissingNsmNums(
        new Set(rawItemMap.keys()),
        async (billNo) =>
          (await deps.crawlingCoreService.probeNsmDeletedBillAlert(billNo)) !==
          null,
      );
    if (sourceDeletedCount > 0) {
      logAndBridge({
        logger: deps.logger,
        method: 'warn',
        message: `NSM pending cron marked ${sourceDeletedCount} notice(s) as source_deleted (seenNsmNums=${rawItemMap.size})`,
        context: 'CrawlingSchedulerService',
        discordBridge: deps.discordBridge,
        bridgeMessage: `NSM pending cron marked **${sourceDeletedCount}** notice(s) as source_deleted after NSM list reconciliation (seenNsmNums=${rawItemMap.size})`,
      });
    }
  }
  // ──────────────────────────────────────────────────────────────────

  // ── NSM detail-page probe (cron path) ───────────────────────────
  // Bills that国民참여입법센터 still lists but deleted on detail page.
  // With ~19,500 NSM bills, batch size 20 covers the full pool in ~14 days
  // (at 20-min cron intervals: 20 bills x 3 cycles/hr x 24 hr = 1,440/day,
  // but content_bill_number IS NULL bills are probed first, so effective
  // coverage is faster for the highest-risk candidates).
  try {
    const NSM_DETAIL_PROBE_BATCH_SIZE = 20;
    const detailProbeDeletedCount =
      await deps.archiveOrchestratorService.probeExistingNsmBillsForSourceDeletion(
        NSM_DETAIL_PROBE_BATCH_SIZE,
      );
    if (detailProbeDeletedCount > 0) {
      logAndBridge({
        logger: deps.logger,
        method: 'warn',
        message: `NSM detail probe confirmed ${detailProbeDeletedCount} deleted bill(s)`,
        context: 'CrawlingSchedulerService',
        discordBridge: deps.discordBridge,
        bridgeMessage: `NSM detail probe confirmed **${detailProbeDeletedCount}** deleted bill(s) (marked source_deleted)`,
      });
    }
  } catch (error) {
    logAndBridge({
      logger: deps.logger,
      method: 'warn',
      message: `NSM detail probe failed: ${error instanceof Error ? error.message : String(error)}`,
      context: 'CrawlingSchedulerService',
      discordBridge: deps.discordBridge,
      bridgeMessage: `NSM detail probe failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  // ──────────────────────────────────────────────────────────────────

  if (nsmNotices.length === 0) return;

  const newNsmNotices =
    await deps.archiveOrchestratorService.filterAlreadyArchivedNotices(
      nsmNotices,
    );

  const newNsmNumSet = new Set(newNsmNotices.map((n) => n.num));
  const newPendingNotices = newNsmNotices.filter((notice) =>
    pendingCandidateNums.has(notice.num),
  );
  const newSyncOnlyItems = newNsmNotices
    .filter((notice) => !pendingCandidateNums.has(notice.num))
    .map((notice) => rawItemMap.get(notice.num))
    .filter((item): item is INsmBillItem => item !== undefined);
  const existingPendingNotices = nsmNotices.filter(
    (notice) =>
      !newNsmNumSet.has(notice.num) && pendingCandidateNums.has(notice.num),
  );
  const archivedNsmOriginNums =
    await deps.noticeArchiveService.getArchivedNullContentIdNums(
      existingPendingNotices.map((notice) => notice.num),
    );
  const existingPendingItems = existingPendingNotices
    .filter((notice) => archivedNsmOriginNums.has(notice.num))
    .map((notice) => rawItemMap.get(notice.num))
    .filter((item): item is INsmBillItem => item !== undefined);

  if (existingPendingItems.length > 0) {
    deps.runBackgroundTask('refresh-existing-pending-bills', async () => {
      await refreshExistingPendingBillsInBackgroundInternal(
        deps,
        existingPendingItems,
      );
    });
  }

  if (newSyncOnlyItems.length > 0) {
    deps.runBackgroundTask('process-new-nsm-sync-only-bills', async () => {
      await processNewNsmSyncOnlyBillsInBackgroundInternal(
        deps,
        newSyncOnlyItems,
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
    { reason: NsmArchiveReason.EXISTING_PENDING_RECOMPARE },
  );

  if (refreshed.length > 0) {
    deps.logger.log(
      `Periodic NSM re-compare scanned ${refreshed.length} archived pending bill(s)`,
    );
  }
}

export async function processNewNsmSyncOnlyBillsInBackgroundInternal(
  deps: PendingWorkflowDeps,
  items: INsmBillItem[],
): Promise<void> {
  const archivedNotices =
    await deps.archiveOrchestratorService.archiveNsmBillItems(items, {
      reason: NsmArchiveReason.NEW_SYNC_ONLY_BILLS,
    });

  if (archivedNotices.length === 0) {
    return;
  }

  const cachePayload = archivedNotices.map((notice) => ({
    ...notice,
    aiSummary: null,
    aiSummaryStatus: 'not_requested' as const,
  }));

  try {
    const freshCache = await deps.cacheService.getRecentNotices(
      APP_CONSTANTS.CACHE.MAX_SIZE,
    );
    const syncedNums = new Set(cachePayload.map((notice) => notice.num));
    await deps.cacheService.updateCache([
      ...cachePayload,
      ...freshCache.filter((notice) => !syncedNums.has(notice.num)),
    ]);
  } catch (error) {
    deps.logger.warn(
      `Cache update for sync-only NSM bills failed: ${(error as Error).message}`,
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
      { reason: NsmArchiveReason.NEW_PENDING_BILLS },
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

  let visibleNoticesWithSummary = noticesWithSummary;

  if (noticesWithReason.length > 0 && noticesWithSummary.length > 0) {
    const persistTargets = noticesWithSummary.filter(
      (n) => (n.aiSummaryStatus ?? 'not_requested') !== 'not_requested',
    );

    if (persistTargets.length > 0) {
      const svcCompat = deps.noticeArchiveService as {
        updateSummaryStatesByNoticeNums?: (
          updates: Array<{
            noticeNum: number;
            summary: string | null;
            status: AISummaryStatus;
          }>,
        ) => Promise<Set<number>>;
        updateSummaryStateByNoticeNum: (
          noticeNum: number,
          summary: string | null,
          status: AISummaryStatus,
        ) => Promise<void>;
      };

      let persistedNoticeNums = new Set<number>();
      let needsSingleFallback = !svcCompat.updateSummaryStatesByNoticeNums;

      if (svcCompat.updateSummaryStatesByNoticeNums) {
        try {
          persistedNoticeNums = await svcCompat.updateSummaryStatesByNoticeNums(
            persistTargets.map((notice) => ({
              noticeNum: notice.num,
              summary: notice.aiSummary ?? null,
              status: notice.aiSummaryStatus ?? 'not_requested',
            })),
          );
        } catch (error) {
          deps.logger.warn(
            `Batch summary persistence failed for pending bills: ${(error as Error).message}; retrying with single-row writes`,
          );
          needsSingleFallback = true;
          persistedNoticeNums = new Set<number>();
        }
      }

      if (needsSingleFallback) {
        const fallbackResults = await Promise.allSettled(
          persistTargets.map((notice) =>
            svcCompat.updateSummaryStateByNoticeNum(
              notice.num,
              notice.aiSummary ?? null,
              notice.aiSummaryStatus ?? 'not_requested',
            ),
          ),
        );

        for (let index = 0; index < fallbackResults.length; index += 1) {
          if (fallbackResults[index].status === 'fulfilled') {
            persistedNoticeNums.add(persistTargets[index].num);
          }
        }
      }

      const persistFailed = persistTargets.length - persistedNoticeNums.size;
      if (persistFailed > 0) {
        deps.logger.warn(
          `Failed to persist ${persistFailed}/${persistTargets.length} pending-bill summary states`,
        );
      }

      const requiredPersistNums = new Set(
        persistTargets.map((notice) => notice.num),
      );
      visibleNoticesWithSummary = noticesWithSummary.filter(
        (notice) =>
          !requiredPersistNums.has(notice.num) ||
          persistedNoticeNums.has(notice.num),
      );
    }
  }

  const allForCache: CachedNotice[] = [
    ...visibleNoticesWithSummary,
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

  if (visibleNoticesWithSummary.length > 0 && noticesWithReason.length > 0) {
    void deps.notificationOrchestratorService
      .sendNotifications(visibleNoticesWithSummary)
      .catch((error) => {
        deps.logger.error(
          'Notification dispatch for pending bills failed:',
          error,
        );
      });
  }
}
