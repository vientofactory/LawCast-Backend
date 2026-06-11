import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { type ITableData, type INsmBillItem } from 'pal-crawl';
import { type CachedNotice } from '../../types/cache.types';
import { CacheService } from '../cache/cache.service';
import { CrawlingCoreService } from './crawling-core.service';
import { SummaryGenerationService } from './summary-generation.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { NotificationOrchestratorService } from '../notification/notification-orchestrator.service';
import {
  NoticeArchiveService,
  type ArchiveSummaryState,
} from '../notice/notice-archive.service';
import { APP_CONSTANTS } from '../../config/app.config';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';

const { PENDING_CRAWL_MAX_RETRIES, PENDING_CRAWL_RETRY_BASE_MS } =
  APP_CONSTANTS.ARCHIVE_SYNC;

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const errno = error as NodeJS.ErrnoException;
  if (errno.code && RETRYABLE_NETWORK_ERROR_CODES.has(errno.code)) {
    return true;
  }
  const message = errno.message ?? '';
  return [...RETRYABLE_NETWORK_ERROR_CODES].some((code) =>
    message.includes(code),
  );
}

@Injectable()
export class CrawlingSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(CrawlingSchedulerService.name);
  private isProcessing = false;
  private isInitialized = false;

  constructor(
    private cacheService: CacheService,
    private crawlingCoreService: CrawlingCoreService,
    private summaryGenerationService: SummaryGenerationService,
    private archiveOrchestratorService: ArchiveOrchestratorService,
    private notificationOrchestratorService: NotificationOrchestratorService,
    private noticeArchiveService: NoticeArchiveService,
    @Optional() private discordBridge: DiscordBridgeService,
  ) {}

  /**
   * Initializes the cache in the background on module startup.
   */
  async onModuleInit() {
    this.isInitialized = false;
    this.logger.log('Scheduling cache initialization in background...');

    void this.initializeCacheInBackground();
  }

  private async initializeCacheInBackground(): Promise<void> {
    this.logger.log('Initializing cache with recent legislative notices...');
    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      CrawlingSchedulerService.name,
      'Cache initialization started',
    );
    try {
      await this.initializeCache();
      this.logger.log('Cache initialization completed successfully');
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        CrawlingSchedulerService.name,
        'Cache initialization completed successfully',
      );
    } catch (error) {
      this.logger.error('Failed to initialize cache:', error);
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        CrawlingSchedulerService.name,
        `Cache initialization failed: ${(error as Error).message}`,
      );
    } finally {
      this.isInitialized = true;
    }
  }

  async handleCron() {
    if (!this.isInitialized) {
      this.logger.warn('Cache not initialized yet, skipping cron job');
      return;
    }

    if (this.isProcessing) {
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        'Previous crawling process is still running, skipping...',
      );
      this.logger.warn(
        'Previous crawling process is still running, skipping...',
      );
      return;
    }

    this.isProcessing = true;

    try {
      await this.performCrawlingAndNotification();
    } catch (error) {
      this.logger.error('Error during crawling process', error);
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        CrawlingSchedulerService.name,
        `Crawling process failed: ${(error as Error).message}`,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Performs the initial cache load without sending any notifications.
   *
   * Fast path (normal restarts): if the archive DB already has data, load
   * notices directly from the DB. This avoids a full crawl that would run
   * concurrently with ArchiveSyncService.runBootstrapPipeline(), halving the
   * external API load on every service restart.
   *
   * Crawl fallback (first-ever startup): if the archive is empty there is no
   * historical data to load from, so we crawl as usual. ArchiveSyncService
   * will archive everything - this service only needs to populate the cache.
   */
  private async initializeCache(): Promise<void> {
    let archivedCount = 0;
    try {
      archivedCount = await this.noticeArchiveService.getArchiveCount();
    } catch (error) {
      this.logger.warn(
        `Failed to read archive count, falling back to crawl: ${(error as Error).message}`,
      );
    }

    if (archivedCount > 0) {
      await this.initializeCacheFromArchive(archivedCount);
    } else {
      await this.initializeCacheFromCrawl();
    }
  }

  /**
   * Loads the cache directly from the archive DB - no external crawl, no
   * Ollama calls. The archive already has the authoritative summary state for
   * every notice so we can populate Redis immediately on restart.
   */
  private async initializeCacheFromArchive(
    archivedCount: number,
  ): Promise<void> {
    this.logger.log(
      `Archive has ${archivedCount} notices - loading cache from DB (no external crawl)`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      CrawlingSchedulerService.name,
      `Cache initialization: loading **${archivedCount}** notice(s) from archive DB`,
    );

    let notices: CachedNotice[];
    try {
      notices = await this.noticeArchiveService.getRecentNoticesForCache(
        APP_CONSTANTS.CACHE.MAX_SIZE,
      );
    } catch (error) {
      this.logger.warn(
        `Archive load failed, falling back to crawl: ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        `Cache init archive load failed, falling back to crawl: ${(error as Error).message}`,
      );
      await this.initializeCacheFromCrawl();
      return;
    }

    if (notices.length === 0) {
      this.logger.warn(
        'Archive returned no active notices - falling back to crawl',
      );
      await this.initializeCacheFromCrawl();
      return;
    }

    await this.cacheService.updateCache(notices);
    this.logger.log(
      `Initialized Redis cache with ${notices.length} notices (from archive DB, no crawl)`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.VERBOSE,
      CrawlingSchedulerService.name,
      `Bootstrap cache loaded: **${notices.length}** notice(s) from archive DB`,
      { count: notices.length, source: 'archive' },
    );
  }

  /**
   * Crawls all pages and loads the result into the Redis cache.
   * Used only when the archive is empty (first-ever startup).
   *
   * Archiving and summary persistence are intentionally omitted here -
   * ArchiveSyncService.runBootstrapPipeline() owns those responsibilities and
   * runs concurrently. Duplicating that work would cause redundant writes and
   * double the external API load.
   */
  private async initializeCacheFromCrawl(): Promise<void> {
    this.logger.log(
      'Archive is empty - crawling to populate cache (first-ever startup)',
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      CrawlingSchedulerService.name,
      'Cache initialization: archive is empty, crawling for initial data',
    );

    const crawledData = await this.crawlingCoreService.crawlAllPages();

    if (!crawledData || crawledData.length === 0) {
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        'No data received from crawler during initialization',
      );
      this.logger.warn('No data received from crawler during initialization');
      return;
    }

    // Load any summary states already written by the concurrent ArchiveSyncService
    // bootstrap (unlikely on first startup but safe to check).
    let archiveSummaryStates: Map<number, ArchiveSummaryState>;
    try {
      archiveSummaryStates =
        await this.noticeArchiveService.getSummaryStateByNoticeNums(
          crawledData.map((notice) => notice.num),
        );
    } catch (error) {
      this.logger.warn(
        `Failed to load archive summary states during init, falling back to empty map: ${(error as Error).message}`,
      );
      archiveSummaryStates = new Map();
    }

    // Enrich with AI summaries - fallback to raw notices on Ollama failure.
    // retryUnavailableArchiveSummary=true: proactively retry any 'unavailable'
    // archive states so the initial cache is as complete as possible.
    // ArchiveSyncService.runSummaryBackfill() will also handle remaining
    // 'not_requested' rows after the full sync completes.
    let noticesWithSummary: CachedNotice[];
    try {
      noticesWithSummary =
        await this.summaryGenerationService.enrichNoticesWithSummary(
          crawledData,
          new Map(),
          archiveSummaryStates,
          {
            logOllamaActivity: true,
            phase: 'init-cache',
            retryUnavailableArchiveSummary: true,
          },
        );
    } catch (error) {
      this.logger.warn(
        `Summary enrichment failed during init, using raw crawled data: ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        `Summary enrichment failed during init: ${(error as Error).message}`,
      );
      noticesWithSummary = crawledData.map((notice) => ({
        ...notice,
        aiSummary: null,
        aiSummaryStatus: 'not_requested' as const,
      }));
    }

    await this.cacheService.updateCache(noticesWithSummary);
    this.logger.log(
      `Initialized Redis cache with ${noticesWithSummary.length} notices (crawled)`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.VERBOSE,
      CrawlingSchedulerService.name,
      `Bootstrap cache loaded: **${noticesWithSummary.length}** notice(s) stored in Redis`,
      { count: noticesWithSummary.length, source: 'crawl' },
    );
  }

  /**
   * Core logic for crawling and dispatching notifications.
   *
   * ─ Fast path (isProcessing lock held) ───────────────────────────────────
   *   Crawl → detect new notices → immediate cache update (preserving existing summaries).
   *   Completes within seconds, so it never conflicts with the 5-minute cron cycle.
   *
   * ─ Background path (runs after lock is released) ────────────────────────
   *   AI summary generation → archiving → cache re-update → notification dispatch.
   *   Long-running work (Ollama calls, HTTP archiving) is offloaded so that the
   *   next cron cycle can start on schedule without being blocked.
   */
  private async performCrawlingAndNotification(): Promise<ITableData[]> {
    // Fetch the current cache first.
    // - existingNoticeMap: used to preserve existing summary states
    // - maxCachedNum: early-exit threshold for crawlAllPages (skips pages below the latest cached num)
    const existingNotices = await this.cacheService.getRecentNotices(
      APP_CONSTANTS.CACHE.MAX_SIZE,
    );
    const existingNoticeMap = this.buildNoticeMap(existingNotices);
    const maxCachedNum = existingNotices[0]?.num;

    const crawledData = await this.crawlingCoreService.crawlAllPages({
      stopBelowNum: maxCachedNum,
      delayMs: APP_CONSTANTS.ARCHIVE_SYNC.CRAWLER_CRON_DELAY_MS,
    });

    if (!crawledData || crawledData.length === 0) {
      this.logger.warn('No data received from crawler');
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        'No data received from crawler',
      );
      return [];
    }

    // Detect new legislative notices.
    // On Redis failure, cacheDiffNotices falls back to the full crawledData - archive dedup acts as the final guard.
    let cacheDiffNotices: ITableData[];
    let cacheAvailable = true;
    try {
      cacheDiffNotices = await this.cacheService.findNewNotices(crawledData);
    } catch {
      cacheAvailable = false;
      cacheDiffNotices = crawledData;
      this.logger.warn(
        'Redis unavailable - falling back to archive-based deduplication',
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        'Redis unavailable - falling back to archive-based deduplication for this cycle',
      );
    }

    const newNotices =
      await this.archiveOrchestratorService.filterAlreadyArchivedNotices(
        cacheDiffNotices,
      );

    void this.discordBridge?.logEvent(
      BridgeLogLevel.VERBOSE,
      CrawlingSchedulerService.name,
      `Crawl stats - crawled: **${crawledData.length}**, cache diff: **${cacheDiffNotices.length}**, new: **${newNotices.length}**${cacheAvailable ? '' : ' *(cache fallback)*'}`,
      {
        totalCrawled: crawledData.length,
        cacheDiff: cacheDiffNotices.length,
        newAfterArchiveFilter: newNotices.length,
        cacheAvailable,
      },
    );

    // ── Fast path: immediately update the cache while preserving existing summary states ──
    // Reflect the crawl result in the cache without waiting for AI summarisation or archiving.
    const noticesWithExistingSummary = crawledData.map((notice) => {
      const existingNotice = existingNoticeMap.get(notice.num);
      if (existingNotice) {
        return {
          ...notice,
          aiSummary: existingNotice.aiSummary ?? null,
          aiSummaryStatus:
            existingNotice.aiSummaryStatus ??
            this.resolveSummaryStatus(existingNotice.aiSummary),
        };
      }
      return {
        ...notice,
        aiSummary: null,
        aiSummaryStatus: 'not_requested' as const,
      };
    });
    await this.cacheService.updateCache(noticesWithExistingSummary);

    if (newNotices.length > 0) {
      this.logger.log(`Found ${newNotices.length} new legislative notices`);
      void this.discordBridge?.logEvent(
        BridgeLogLevel.LOG,
        CrawlingSchedulerService.name,
        `Found **${newNotices.length}** new legislative notice(s)`,
        {
          subjects: newNotices.slice(0, 5).map((n) => n.subject ?? n.num),
          total: newNotices.length,
        },
      );

      // ── Background path: AI summary → archiving → cache re-update → notifications ──
      // Runs independently after the isProcessing lock is released, so it never blocks the cron cycle.
      void this.processNewNoticesInBackground(
        newNotices,
        existingNoticeMap,
      ).catch((error) => {
        this.logger.error(
          'Background processing for new notices failed:',
          error,
        );
        void this.discordBridge?.logEvent(
          BridgeLogLevel.ERROR,
          CrawlingSchedulerService.name,
          `Background new notice processing failed: ${(error as Error).message}`,
        );
      });
    } else {
      void this.discordBridge?.logEvent(
        BridgeLogLevel.VERBOSE,
        CrawlingSchedulerService.name,
        `No new notices - cache refreshed with **${crawledData.length}** existing notice(s)`,
        { total: crawledData.length },
      );

      // ── Background path: retry summaries that failed to generate in a previous cycle ──
      void this.retryUnavailableSummariesInBackground(
        noticesWithExistingSummary,
        existingNoticeMap,
      ).catch((error) => {
        this.logger.warn(
          `Background summary retry failed: ${(error as Error).message}`,
        );
      });
    }

    return newNotices;
  }

  /**
   * Handles AI summary generation, archiving, cache re-update, and notification dispatch
   * for newly detected legislative notices in the background.
   *
   * Runs outside the isProcessing lock, so it never blocks the 5-minute cron cycle.
   * Re-fetches the latest cache before merging summaries to avoid race conditions
   * with a concurrently running cron cycle.
   */
  private async processNewNoticesInBackground(
    newNotices: ITableData[],
    existingNoticeMap: Map<number, CachedNotice>,
  ): Promise<void> {
    // Stage: Archive summary states - fallback to empty map on DB failure
    let archiveSummaryStates: Map<number, ArchiveSummaryState>;
    try {
      archiveSummaryStates =
        await this.noticeArchiveService.getSummaryStateByNoticeNums(
          newNotices.map((notice) => notice.num),
        );
    } catch (error) {
      this.logger.warn(
        `Failed to load archive summary states, falling back to empty map: ${(error as Error).message}`,
      );
      archiveSummaryStates = new Map();
    }

    // Stage: AI summary enrichment - fallback to raw notices on Ollama/crawl failure
    let newNoticesWithSummary: CachedNotice[];
    try {
      newNoticesWithSummary =
        await this.summaryGenerationService.enrichNoticesWithSummary(
          newNotices,
          existingNoticeMap,
          archiveSummaryStates,
        );
    } catch (error) {
      this.logger.error(
        `Summary enrichment failed for new notices, using raw data: ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        CrawlingSchedulerService.name,
        `Summary enrichment failed: ${(error as Error).message}`,
      );
      newNoticesWithSummary = newNotices.map((notice) => ({
        ...notice,
        aiSummary: null,
        aiSummaryStatus: 'not_requested' as const,
      }));
    }

    // Stage: Archive - log and continue so cache + notifications are never blocked
    try {
      await this.archiveOrchestratorService.archiveNotices(
        newNoticesWithSummary,
      );
    } catch (error) {
      this.logger.error(
        `Archive stage failed for new notices, proceeding with cache and notifications: ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        CrawlingSchedulerService.name,
        `Archive stage failed: ${(error as Error).message}`,
      );
    }

    // Stage: Merge summaries into freshest cache snapshot (race-safe re-fetch)
    // Another cron cycle may have updated the cache while this background task was running,
    // so re-fetch the latest cache before merging the newly generated summaries.
    const freshCacheNotices = await this.cacheService.getRecentNotices(
      APP_CONSTANTS.CACHE.MAX_SIZE,
    );
    const newNoticeMap = this.buildNoticeMap(newNoticesWithSummary);
    const mergedNotices = freshCacheNotices.map((notice) => {
      const withSummary = newNoticeMap.get(notice.num);
      if (withSummary) {
        return {
          ...notice,
          aiSummary: withSummary.aiSummary ?? null,
          aiSummaryStatus: withSummary.aiSummaryStatus ?? 'not_requested',
        };
      }
      return notice;
    });

    // Stage: Retry unavailable summaries - fallback to merged notices on failure
    let finalNotices: CachedNotice[];
    try {
      finalNotices = await this.retryUnavailableSummariesFromPreviousCycle(
        mergedNotices,
        existingNoticeMap,
      );
    } catch (error) {
      this.logger.warn(
        `Unavailable summary retry failed, using merged notices: ${(error as Error).message}`,
      );
      finalNotices = mergedNotices;
    }

    await this.cacheService.updateCache(finalNotices);
    this.logger.log(
      `Background processing complete: cache updated with summaries for ${newNotices.length} new notice(s)`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.DEBUG,
      CrawlingSchedulerService.name,
      `Background processing complete: cache updated with summaries for **${newNotices.length}** new notice(s)`,
      { count: newNotices.length },
    );

    // Stage: Send notifications (already dispatched asynchronously)
    void this.notificationOrchestratorService
      .sendNotifications(newNoticesWithSummary)
      .catch((error) => {
        this.logger.error('Background notification dispatch failed:', error);
        void this.discordBridge?.logEvent(
          BridgeLogLevel.ERROR,
          CrawlingSchedulerService.name,
          'Background notification dispatch failed',
        );
      });
  }

  /**
   * Retries AI summaries that failed to generate in a previous cycle,
   * running in the background during cycles where no new notices are detected.
   */
  private async retryUnavailableSummariesInBackground(
    notices: CachedNotice[],
    existingNoticeMap: Map<number, CachedNotice>,
  ): Promise<void> {
    const retried = await this.retryUnavailableSummariesFromPreviousCycle(
      notices,
      existingNoticeMap,
    );
    await this.cacheService.updateCache(retried);
  }

  private buildNoticeMap(notices: CachedNotice[]): Map<number, CachedNotice> {
    return new Map(notices.map((notice) => [notice.num, notice]));
  }

  private resolveSummaryStatus(
    summary?: string | null,
  ): 'ready' | 'unavailable' {
    return summary?.trim() ? 'ready' : 'unavailable';
  }

  private async persistRetriedArchiveSummaryStates(
    noticesWithSummary: CachedNotice[],
    archiveSummaryStates: Map<number, ArchiveSummaryState>,
  ): Promise<void> {
    const changedRetriedNotices = noticesWithSummary.filter((notice) => {
      const previousState = archiveSummaryStates.get(notice.num);

      if (!previousState) {
        return false;
      }

      // Persist when the previous state was either:
      //  - 'not_requested': archive row saved without a summary (e.g. full-sync bootstrap)
      //  - 'unavailable': previous generation failed and was just retried
      const wasPending =
        previousState.aiSummaryStatus === 'not_requested' ||
        previousState.aiSummaryStatus === 'unavailable';

      if (!wasPending) {
        return false;
      }

      const previousSummary = previousState.aiSummary?.trim() || null;
      const nextSummary = notice.aiSummary?.trim() || null;
      const nextStatus = notice.aiSummaryStatus ?? 'not_requested';

      return (
        previousSummary !== nextSummary ||
        previousState.aiSummaryStatus !== nextStatus
      );
    });

    if (changedRetriedNotices.length === 0) {
      return;
    }

    const persistResults = await Promise.allSettled(
      changedRetriedNotices.map(async (notice) => {
        await this.noticeArchiveService.updateSummaryStateByNoticeNum(
          notice.num,
          notice.aiSummary ?? null,
          notice.aiSummaryStatus ?? 'not_requested',
        );
      }),
    );

    const persistFailed = persistResults.filter(
      (r) => r.status === 'rejected',
    ).length;
    if (persistFailed > 0) {
      this.logger.warn(
        `Failed to persist ${persistFailed}/${changedRetriedNotices.length} retried summary states`,
      );
    }

    this.logger.log(
      `Persisted retried summary state for ${changedRetriedNotices.length - persistFailed} archived notices`,
    );
  }

  private async retryUnavailableSummariesFromPreviousCycle(
    notices: CachedNotice[],
    existingNoticeMap: Map<number, CachedNotice>,
  ): Promise<CachedNotice[]> {
    const retryCandidates = notices.filter((notice) => {
      const existingNotice = existingNoticeMap.get(notice.num);

      return (
        !!existingNotice &&
        existingNotice.aiSummaryStatus === 'unavailable' &&
        notice.aiSummaryStatus === 'unavailable' &&
        !!notice.contentId
      );
    });

    if (retryCandidates.length === 0) {
      return notices;
    }

    this.logger.log(
      `Retrying unavailable summaries for ${retryCandidates.length} notices`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.WARN,
      CrawlingSchedulerService.name,
      `Retrying unavailable summaries for ${retryCandidates.length} notices`,
    );

    const retryResults = await Promise.all(
      retryCandidates.map(async (notice, index) => {
        const summaryResult =
          await this.summaryGenerationService.generateSummaryForNotice(notice, {
            logOllamaActivity: true,
            phase: 'cron-retry',
            index,
            total: retryCandidates.length,
          });

        return {
          num: notice.num,
          aiSummary: summaryResult.aiSummary,
          aiSummaryStatus: summaryResult.aiSummaryStatus,
        };
      }),
    );

    const retryResultMap = new Map(
      retryResults.map((result) => [result.num, result]),
    );

    const recoveredCount = retryResults.filter(
      (r) => r.aiSummaryStatus === 'ready',
    ).length;
    void this.discordBridge?.logEvent(
      BridgeLogLevel.DEBUG,
      CrawlingSchedulerService.name,
      `Summary retry: **${recoveredCount}/${retryCandidates.length}** recovered`,
      {
        candidates: retryCandidates.length,
        recovered: recoveredCount,
        stillUnavailable: retryCandidates.length - recoveredCount,
      },
    );

    const mergedNotices = notices.map((notice) => {
      const retryResult = retryResultMap.get(notice.num);

      if (!retryResult) {
        return notice;
      }

      return {
        ...notice,
        aiSummary: retryResult.aiSummary,
        aiSummaryStatus: retryResult.aiSummaryStatus,
      };
    });

    const changedRetriedNotices = mergedNotices.filter((notice) => {
      const previousNotice = existingNoticeMap.get(notice.num);

      if (!previousNotice || previousNotice.aiSummaryStatus !== 'unavailable') {
        return false;
      }

      const previousSummary = previousNotice.aiSummary?.trim() || null;
      const nextSummary = notice.aiSummary?.trim() || null;
      const nextStatus = notice.aiSummaryStatus ?? 'not_requested';

      return (
        previousSummary !== nextSummary ||
        previousNotice.aiSummaryStatus !== nextStatus
      );
    });

    if (changedRetriedNotices.length === 0) {
      return mergedNotices;
    }

    const cronPersistResults = await Promise.allSettled(
      changedRetriedNotices.map(async (notice) => {
        await this.noticeArchiveService.updateSummaryStateByNoticeNum(
          notice.num,
          notice.aiSummary ?? null,
          notice.aiSummaryStatus ?? 'not_requested',
        );
      }),
    );

    const cronPersistFailed = cronPersistResults.filter(
      (r) => r.status === 'rejected',
    ).length;
    if (cronPersistFailed > 0) {
      this.logger.warn(
        `Failed to persist ${cronPersistFailed}/${changedRetriedNotices.length} cron retried summary states`,
      );
    }

    this.logger.log(
      `Persisted cron retried summary state for ${changedRetriedNotices.length - cronPersistFailed} notices`,
    );

    return mergedNotices;
  }

  /**
   * Detects newly proposed (\"\ubc1c\uc758\") bills from \uad6d\ubbfc\ucc38\uc5ec\uc785\ubc95\uc13c\ud130 (NsmLmSts) that have not
   * yet entered the formal \uc785\ubc95\uc608\uace0 process, archives them, and dispatches
   * notifications - allowing the system to surface new legislation earlier
   * than the pal.assembly.go.kr crawl can.
   *
   * Runs concurrently with (but independently of) the main crawl cycle so
   * a slow NsmLmSts response never delays pal.assembly.go.kr processing.
   */
  async handlePendingCron(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= PENDING_CRAWL_MAX_RETRIES; attempt++) {
      try {
        await this.performPendingBillsCrawl();
        return;
      } catch (error) {
        lastError = error;
        const canRetry =
          attempt < PENDING_CRAWL_MAX_RETRIES && isRetryableNetworkError(error);

        if (!canRetry) {
          break;
        }

        const backoffMs = PENDING_CRAWL_RETRY_BASE_MS * 2 ** attempt;
        const attemptLabel = `${attempt + 1}/${PENDING_CRAWL_MAX_RETRIES + 1}`;
        const message = (error as Error).message;
        this.logger.warn(
          `Pending bills crawl failed (attempt ${attemptLabel}): ${message} - retrying in ${backoffMs}ms`,
        );
        void this.discordBridge?.logEvent(
          BridgeLogLevel.WARN,
          CrawlingSchedulerService.name,
          `Pending bills crawl failed (attempt ${attemptLabel}): ${message} - retrying in ${backoffMs}ms`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    this.logger.error('Error during pending bills crawl', lastError);
    void this.discordBridge?.logEvent(
      BridgeLogLevel.ERROR,
      CrawlingSchedulerService.name,
      `Pending bills crawl failed: ${(lastError as Error).message}`,
    );
  }

  private async performPendingBillsCrawl(): Promise<void> {
    const rawItemMap = new Map<number, INsmBillItem>();
    const pendingNotices: CachedNotice[] = [];

    for await (const page of this.crawlingCoreService.getAllNsmPendingPages(
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
      await this.archiveOrchestratorService.filterAlreadyArchivedNotices(
        pendingNotices,
      );

    if (newPendingNotices.length === 0) return;

    this.logger.log(
      `Found ${newPendingNotices.length} new pending bill(s) from NsmLmSts`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.LOG,
      CrawlingSchedulerService.name,
      `Found **${newPendingNotices.length}** new pending bill(s) from NsmLmSts`,
      {
        subjects: newPendingNotices.slice(0, 5).map((n) => n.subject),
        total: newPendingNotices.length,
      },
    );

    const newPendingItems = newPendingNotices
      .map((n) => rawItemMap.get(n.num))
      .filter((item): item is INsmBillItem => item !== undefined);

    // Archive and notify in the background so the cron lock is not held.
    void this.processPendingBillsInBackground(
      newPendingItems,
      newPendingNotices,
    ).catch((error) => {
      this.logger.error(
        'Background processing for pending bills failed:',
        error,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        CrawlingSchedulerService.name,
        `Pending bills background processing failed: ${(error as Error).message}`,
      );
    });
  }

  private async processPendingBillsInBackground(
    newPendingItems: INsmBillItem[],
    newPendingNotices: CachedNotice[],
  ): Promise<void> {
    // Stage 1: Archive with full NsmLmSts detail (proposalReason, 발의정보 원문).
    // Returns archived CachedNotice[] with proposalReason populated - no extra
    // DB round-trip needed for the AI summary stage below.
    // Screenshots are scheduled as fire-and-forget inside archiveNsmBillItems,
    // matching the behaviour of archiveNotices for pal.assembly.go.kr bills.
    let archivedNotices: CachedNotice[] = [];
    try {
      archivedNotices =
        await this.archiveOrchestratorService.archiveNsmBillItems(
          newPendingItems,
        );
    } catch (error) {
      this.logger.error(
        `Archive stage failed for pending bills, proceeding with cache and notifications: ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        CrawlingSchedulerService.name,
        `Pending bills archive stage failed: ${(error as Error).message}`,
      );
    }

    // Stage 2: AI summary generation.
    // Use the archived notices (with proposalReason) when available; fall back
    // to the raw pending notices so cache/notifications are never blocked.
    const summaryBase =
      archivedNotices.length > 0 ? archivedNotices : newPendingNotices;
    const concurrency = APP_CONSTANTS.CRAWLING.SUMMARY_CONCURRENCY;

    const noticesWithSummary: CachedNotice[] = [];
    for (let i = 0; i < summaryBase.length; i += concurrency) {
      const chunk = summaryBase.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map(async (notice) => {
          try {
            const result =
              await this.summaryGenerationService.generateSummaryForNotice(
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
        }),
      );
      noticesWithSummary.push(...results);
    }

    // Stage 3: Persist generated summaries to DB so backfill phases skip them.
    if (archivedNotices.length > 0) {
      await Promise.allSettled(
        noticesWithSummary
          .filter(
            (n) => (n.aiSummaryStatus ?? 'not_requested') !== 'not_requested',
          )
          .map((n) =>
            this.noticeArchiveService.updateSummaryStateByNoticeNum(
              n.num,
              n.aiSummary ?? null,
              n.aiSummaryStatus ?? 'not_requested',
            ),
          ),
      );
    }

    // Stage 4: Merge into the freshest cache snapshot (race-safe re-fetch),
    // mirroring the same pattern used in processNewNoticesInBackground.
    try {
      const freshCache = await this.cacheService.getRecentNotices(
        APP_CONSTANTS.CACHE.MAX_SIZE,
      );
      const newNums = new Set(noticesWithSummary.map((n) => n.num));
      const merged = [
        ...noticesWithSummary,
        ...freshCache.filter((n) => !newNums.has(n.num)),
      ];
      await this.cacheService.updateCache(merged);
    } catch (error) {
      this.logger.warn(
        `Cache update for pending bills failed: ${(error as Error).message}`,
      );
    }

    // Stage 5: Send notifications WITH AI summaries.
    void this.notificationOrchestratorService
      .sendNotifications(noticesWithSummary)
      .catch((error) => {
        this.logger.error(
          'Notification dispatch for pending bills failed:',
          error,
        );
      });
  }
}
