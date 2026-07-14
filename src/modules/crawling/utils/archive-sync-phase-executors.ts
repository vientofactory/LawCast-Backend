import {
  type INsmBillItem,
  type ISearchResult,
  type ITableData,
} from 'pal-crawl';
import { type CachedNotice } from '../../../types/cache.types';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../../utils/logger.utils';
import { mapConcurrently } from '../../../utils/concurrency.utils';
import { type DiscordBridgeService } from '../../discord-bridge/discord-bridge.service';
import { type ArchiveOrchestratorService } from '../archive-orchestrator.service';
import { type CacheService } from '../../cache/cache.service';
import { CrawlingCoreService } from '../crawling-core.service';
import { type NoticeArchiveService } from '../../notice/notice-archive.service';
import { type SummaryGenerationService } from '../summary-generation.service';
import { type ChangeTrackingService } from '../../change-tracking/change-tracking.service';
import { AI_SUMMARY_STATUS } from './ai-summary-status.utils';
import { type FullSyncResult } from '../archive-sync.service';
import { type IsDoneSyncResult } from '../archive-sync.service';
import { type ChainIntegrityAuditResult } from '../archive-sync.service';
import { type PendingSyncResult } from '../archive-sync.service';
import { type SummaryBackfillResult } from '../archive-sync.service';
import { type SummaryUnavailableRetryResult } from '../archive-sync.service';
import { delayMs } from '../../../utils/async-delay.utils';
import { logAndBridge } from '../../../utils/bridge-log.utils';

const ARCHIVE_SYNC_CONTEXT = 'ArchiveSyncService';
const archiveSyncLogger = {
  log: (message: string) => LoggerUtils.log(ARCHIVE_SYNC_CONTEXT, message),
  warn: (message: string) => LoggerUtils.warn(ARCHIVE_SYNC_CONTEXT, message),
  error: (message: string) => LoggerUtils.error(ARCHIVE_SYNC_CONTEXT, message),
  debug: (message: string) => LoggerUtils.debug(ARCHIVE_SYNC_CONTEXT, message),
  verbose: (message: string) =>
    LoggerUtils.verbose(ARCHIVE_SYNC_CONTEXT, message),
};

export interface ArchiveSyncExecutorDeps {
  crawlingCoreService: CrawlingCoreService;
  noticeArchiveService: NoticeArchiveService;
  archiveOrchestratorService: ArchiveOrchestratorService;
  summaryGenerationService: SummaryGenerationService;
  cacheService: CacheService;
  changeTrackingService?: ChangeTrackingService;
  discordBridge?: DiscordBridgeService;
}

export interface ArchiveSyncExecutorOptions {
  crawlerPageUnit: number;
  crawlerDelayMs: number;
  summaryBackfillBatchSize: number;
  summaryBackfillConcurrency: number;
  donePageMaxRetries: number;
  donePageRetryBaseMs: number;
}

export async function executeFullSyncPhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<FullSyncResult> {
  LoggerUtils.log('ArchiveSyncService', 'Full archive sync started');

  let totalPagesScanned = 0;
  let totalNoticesScanned = 0;
  let newlyArchivedCount = 0;
  const seenPalActiveNums = new Set<number>();

  deps.noticeArchiveService.beginChangeNotificationCollection();

  try {
    for await (const page of deps.crawlingCoreService.getAllPages(
      { pageUnit: options.crawlerPageUnit },
      { delayMs: options.crawlerDelayMs, concurrency: 1 },
    )) {
      totalPagesScanned++;
      const pageItems: ITableData[] = page.items ?? [];
      for (const item of pageItems) {
        seenPalActiveNums.add(item.num);
      }
      totalNoticesScanned += pageItems.length;

      const newNotices =
        await deps.archiveOrchestratorService.filterAlreadyArchivedNotices(
          pageItems,
        );

      if (newNotices.length > 0) {
        const saved = await deps.archiveOrchestratorService.archiveNotices(
          newNotices.map((n) => ({
            ...n,
            aiSummary: null,
            aiSummaryStatus: 'not_requested' as const,
          })),
          { reason: 'full-sync-new-notices' },
        );
        newlyArchivedCount += saved;
      }

      const newNums = new Set(newNotices.map((n) => n.num));
      const alreadyArchivedWithContentId = pageItems.filter(
        (item) => !newNums.has(item.num) && item.contentId !== null,
      );
      if (alreadyArchivedWithContentId.length > 0) {
        const nullContentIdNums =
          await deps.noticeArchiveService.getArchivedNullContentIdNums(
            alreadyArchivedWithContentId.map((i) => i.num),
          );
        if (nullContentIdNums.size > 0) {
          const toUpgrade = alreadyArchivedWithContentId.filter((item) =>
            nullContentIdNums.has(item.num),
          );

          const upgraded = await deps.archiveOrchestratorService.archiveNotices(
            toUpgrade.map((item) => ({
              num: item.num,
              subject: item.subject,
              proposerCategory: item.proposerCategory,
              committee: item.committee,
              link: item.link,
              contentId: item.contentId,
              attachments: item.attachments ?? {
                pdfFile: null,
                hwpFile: null,
              },
            })),
            { reason: 'nsm-pal-upgrade' },
          );
          if (upgraded > 0) {
            logAndBridge({
              logger: {
                log: (message: string) =>
                  LoggerUtils.logDev('ArchiveSyncService', message),
              },
              method: 'log',
              message: `Upgraded ${upgraded} pending bill(s) from NSM to PAL with full archive refresh`,
              context: 'ArchiveSyncService',
              discordBridge: deps.discordBridge,
              bridgeLevel: BridgeLogLevel.DEBUG,
              bridgeMessage: `NSM->PAL archive refresh applied: upgraded **${upgraded}** bill(s) on full sync`,
              metadata: {
                upgraded,
                detected: toUpgrade.length,
                sampleNoticeNums: toUpgrade
                  .slice(0, 10)
                  .map((item) => item.num),
              },
            });
          }
        }
      }

      LoggerUtils.debugDev(
        'ArchiveSyncService',
        `Page ${page.currentPage}/${page.totalPages}: total=${pageItems.length} new=${newNotices.length}`,
      );
    }

    const sourceDeletedCount =
      await deps.noticeArchiveService.markSourceDeletedByMissingPalNums(
        seenPalActiveNums,
      );
    if (sourceDeletedCount > 0) {
      LoggerUtils.log(
        'ArchiveSyncService',
        `Marked ${sourceDeletedCount} notice(s) as source_deleted after PAL full sync reconciliation`,
      );
    }

    return { totalPagesScanned, totalNoticesScanned, newlyArchivedCount };
  } finally {
    await deps.noticeArchiveService.endChangeNotificationCollection();
  }
}

export async function executePendingSyncPhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<PendingSyncResult> {
  LoggerUtils.logDev(
    'ArchiveSyncService',
    'Pending bills sync (NsmLmSts) started',
  );

  deps.noticeArchiveService.beginChangeNotificationCollection();

  try {
    const rawItemMap = new Map<number, INsmBillItem>();
    const pendingNotices: ReturnType<
      typeof CrawlingCoreService.nsmBillToCachedNotice
    >[] = [];

    for await (const page of deps.crawlingCoreService.getAllNsmPendingPages(
      {},
      { delayMs: options.crawlerDelayMs, concurrency: 1 },
    )) {
      for (const item of page.items ?? []) {
        const notice = CrawlingCoreService.nsmBillToCachedNotice(item);
        if (!rawItemMap.has(notice.num)) {
          rawItemMap.set(notice.num, item);
          pendingNotices.push(notice);
        }
      }
    }

    const totalScanned = pendingNotices.length;

    if (totalScanned === 0) {
      LoggerUtils.logDev(
        'ArchiveSyncService',
        'No pending bills found in NsmLmSts',
      );
      return { totalScanned: 0, newlyArchivedCount: 0 };
    }

    const newPendingNotices =
      await deps.archiveOrchestratorService.filterAlreadyArchivedNotices(
        pendingNotices,
      );

    let newlyArchivedCount = 0;
    if (newPendingNotices.length > 0) {
      const newPendingItems = newPendingNotices
        .map((n) => rawItemMap.get(n.num))
        .filter((item): item is INsmBillItem => item !== undefined);
      const archived =
        await deps.archiveOrchestratorService.archiveNsmBillItems(
          newPendingItems,
          { reason: 'new-pending-bills' },
        );
      newlyArchivedCount = archived.length;
    }

    logAndBridge({
      logger: archiveSyncLogger,
      method: 'log',
      message: `Pending sync done - scanned=${totalScanned} new=${newPendingNotices.length} archived=${newlyArchivedCount}`,
      context: ARCHIVE_SYNC_CONTEXT,
      discordBridge: deps.discordBridge,
      bridgeMessage: `Pending sync complete - scanned=${totalScanned} new=${newPendingNotices.length} archived=${newlyArchivedCount}`,
    });

    return { totalScanned, newlyArchivedCount };
  } finally {
    await deps.noticeArchiveService.endChangeNotificationCollection();
  }
}

export async function fetchDonePageWithRetry(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
  pageIndex: number,
): Promise<ISearchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.donePageMaxRetries; attempt++) {
    try {
      return await deps.crawlingCoreService.searchDone({
        pageIndex,
        pageUnit: options.crawlerPageUnit,
      });
    } catch (error) {
      lastError = error;
      if (attempt < options.donePageMaxRetries) {
        const backoff = options.donePageRetryBaseMs * (attempt + 1);
        logAndBridge({
          logger: archiveSyncLogger,
          method: 'warn',
          message: `isDone page ${pageIndex} failed (attempt ${attempt + 1}/${options.donePageMaxRetries + 1}): ${(error as Error).message} - retrying in ${backoff}ms`,
          context: ARCHIVE_SYNC_CONTEXT,
          discordBridge: deps.discordBridge,
          bridgeMessage: `isDone page **${pageIndex}** failed (attempt ${attempt + 1}/${options.donePageMaxRetries + 1}): ${(error as Error).message} - retrying in ${backoff}ms`,
        });
        await delayMs(backoff);
      }
    }
  }
  throw lastError;
}

export async function reconcileIsDonePhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<IsDoneSyncResult> {
  LoggerUtils.log('ArchiveSyncService', 'isDone reconciliation started');

  let markedDoneCount = 0;
  let fetchedDoneCount = 0;

  const firstPage = await fetchDonePageWithRetry(deps, options, 1);
  const totalPages = firstPage.totalPages;

  let pageNums = (firstPage.items ?? []).map((item) => item.num);
  fetchedDoneCount += pageNums.length;
  markedDoneCount +=
    await deps.noticeArchiveService.markNoticesDoneByNums(pageNums);

  for (let pageIndex = 2; pageIndex <= totalPages; pageIndex++) {
    await delayMs(options.crawlerDelayMs);
    const page = await fetchDonePageWithRetry(deps, options, pageIndex);
    pageNums = (page.items ?? []).map((item) => item.num);
    fetchedDoneCount += pageNums.length;
    markedDoneCount +=
      await deps.noticeArchiveService.markNoticesDoneByNums(pageNums);
  }

  logAndBridge({
    logger: archiveSyncLogger,
    method: 'log',
    message: `isDone reconciliation done - fetched=${fetchedDoneCount} marked=${markedDoneCount}`,
    context: ARCHIVE_SYNC_CONTEXT,
    discordBridge: deps.discordBridge,
    bridgeMessage: `isDone sync complete - fetched=${fetchedDoneCount} marked=${markedDoneCount}`,
  });

  return { fetchedDoneCount, markedDoneCount };
}

export async function executeSummaryBackfillPhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<SummaryBackfillResult> {
  if (!deps.summaryGenerationService.isAiSummaryEnabled()) {
    LoggerUtils.debugDev(
      'ArchiveSyncService',
      'Summary backfill skipped - AI summary disabled',
    );
    return { scanned: 0, generated: 0, skipped: 0, failed: 0 };
  }

  let scanned = 0;
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (;;) {
    const batch = await deps.noticeArchiveService.getPendingSummaryPage(
      options.summaryBackfillBatchSize,
    );
    if (batch.length === 0) break;

    const batchCacheUpdates: CachedNotice[] = [];
    const batchStatuses = await mapConcurrently(
      batch,
      options.summaryBackfillConcurrency,
      async (notice) => {
        try {
          const result =
            await deps.summaryGenerationService.generateSummaryForNotice(
              notice,
              { phase: 'summary-backfill' },
            );
          await deps.noticeArchiveService.updateSummaryStateByNoticeNum(
            notice.num,
            result.aiSummary,
            result.aiSummaryStatus,
          );
          batchCacheUpdates.push({
            ...notice,
            aiSummary: result.aiSummary,
            aiSummaryStatus: result.aiSummaryStatus,
          });
          return result.aiSummaryStatus;
        } catch (error) {
          LoggerUtils.error(
            'ArchiveSyncService',
            `Summary backfill failed for notice ${notice.num}: ${(error as Error).message}`,
          );

          await deps.noticeArchiveService
            .updateSummaryStateByNoticeNum(
              notice.num,
              null,
              AI_SUMMARY_STATUS.UNAVAILABLE,
            )
            .catch((persistError) => {
              LoggerUtils.warn(
                'ArchiveSyncService',
                `Failed to persist unavailable summary state for notice ${notice.num}: ${(persistError as Error).message}`,
              );
            });

          batchCacheUpdates.push({
            ...notice,
            aiSummary: null,
            aiSummaryStatus: AI_SUMMARY_STATUS.UNAVAILABLE,
          });

          return AI_SUMMARY_STATUS.UNAVAILABLE;
        }
      },
    );

    if (batchCacheUpdates.length > 0) {
      await deps.cacheService.updateCache(batchCacheUpdates);
    }

    for (const status of batchStatuses) {
      if (status === 'ready') generated++;
      else if (status === 'not_supported') skipped++;
      else failed++;
    }

    scanned += batch.length;
    if (batch.length < options.summaryBackfillBatchSize) break;
  }

  LoggerUtils.log(
    'ArchiveSyncService',
    `Summary backfill done - scanned=${scanned} generated=${generated} skipped=${skipped} failed=${failed}`,
  );

  return { scanned, generated, skipped, failed };
}

export async function executeUnavailableRetryPhase(
  deps: ArchiveSyncExecutorDeps,
  options: ArchiveSyncExecutorOptions,
): Promise<SummaryUnavailableRetryResult> {
  if (!deps.summaryGenerationService.isAiSummaryEnabled()) {
    LoggerUtils.debugDev(
      'ArchiveSyncService',
      'Unavailable summary retry skipped - AI summary disabled',
    );
    return { scanned: 0, recovered: 0, skipped: 0, stillFailed: 0 };
  }

  let scanned = 0;
  let recovered = 0;
  let skipped = 0;
  let stillFailed = 0;
  let skip = 0;

  for (;;) {
    const batch = await deps.noticeArchiveService.getUnavailableSummaryPage(
      skip,
      options.summaryBackfillBatchSize,
    );
    if (batch.length === 0) break;

    const batchCacheUpdates: CachedNotice[] = [];
    const batchStatuses = await mapConcurrently(
      batch,
      options.summaryBackfillConcurrency,
      async (notice) => {
        try {
          const result =
            await deps.summaryGenerationService.generateSummaryForNotice(
              notice,
              { phase: 'unavailable-retry' },
            );
          await deps.noticeArchiveService.updateSummaryStateByNoticeNum(
            notice.num,
            result.aiSummary,
            result.aiSummaryStatus,
          );
          batchCacheUpdates.push({
            ...notice,
            aiSummary: result.aiSummary,
            aiSummaryStatus: result.aiSummaryStatus,
          });
          return result.aiSummaryStatus;
        } catch (error) {
          LoggerUtils.error(
            'ArchiveSyncService',
            `Unavailable retry failed for notice ${notice.num}: ${(error as Error).message}`,
          );
          return 'unavailable' as const;
        }
      },
    );

    if (batchCacheUpdates.length > 0) {
      await deps.cacheService.updateCache(batchCacheUpdates);
    }

    for (const status of batchStatuses) {
      if (status === 'ready') recovered++;
      else if (status === 'not_supported') skipped++;
      else stillFailed++;
    }

    scanned += batch.length;
    if (batch.length < options.summaryBackfillBatchSize) break;
    skip += options.summaryBackfillBatchSize;
  }

  LoggerUtils.log(
    'ArchiveSyncService',
    `Unavailable summary retry done - scanned=${scanned} recovered=${recovered} skipped=${skipped} stillFailed=${stillFailed}`,
  );

  return { scanned, recovered, skipped, stillFailed };
}

export async function executeChainIntegrityAuditPhase(
  deps: ArchiveSyncExecutorDeps,
): Promise<ChainIntegrityAuditResult> {
  if (!deps.changeTrackingService) {
    LoggerUtils.warn(
      'ArchiveSyncService',
      'Chain integrity audit skipped - ChangeTrackingService unavailable',
    );
    return {
      checkedAt: new Date().toISOString(),
      scope: 'daily',
      noticeCount: 0,
      eventCount: 0,
      failureCount: 0,
      checkpointRootHash: null,
      skipped: true,
    };
  }

  const report =
    await deps.changeTrackingService.runScheduledChainAudit('daily');

  return {
    checkedAt: report.checkedAt,
    scope: report.scope,
    noticeCount: report.noticeCount,
    eventCount: report.eventCount,
    failureCount: report.failureCount,
    checkpointRootHash: report.checkpointRootHash,
    skipped: false,
  };
}
