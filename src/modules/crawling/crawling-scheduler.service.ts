import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { type ITableData } from 'pal-crawl';
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
import { delayMs } from '../../utils/async-delay.utils';
import { isRetryableNetworkOrSystemError } from '../../utils/db-error.utils';
import { logAndBridge } from '../../utils/bridge-log.utils';
import { LoggerUtils } from '../../utils/logger.utils';
import { CrawlingSchedulerSummarySupport } from './utils/crawling-scheduler-summary-support';
import { CrawlingSchedulerProposalRetry } from './utils/crawling-scheduler-proposal-retry';
import { handlePendingCronInternal } from './utils/crawling-scheduler-pending-support';

const { PENDING_CRAWL_MAX_RETRIES, PENDING_CRAWL_RETRY_BASE_MS } =
  APP_CONSTANTS.ARCHIVE_SYNC;

function isRetryableNetworkError(error: unknown): boolean {
  return isRetryableNetworkOrSystemError(error);
}
@Injectable()
export class CrawlingSchedulerService implements OnModuleInit {
  private readonly logger = LoggerUtils.getContextLogger(
    CrawlingSchedulerService.name,
  );
  private isProcessing = false;
  private isInitialized = false;
  private readonly activeBackgroundTasks = new Set<string>();
  private readonly summarySupport: CrawlingSchedulerSummarySupport;
  private readonly proposalRetrySupport: CrawlingSchedulerProposalRetry;

  constructor(
    private cacheService: CacheService,
    private crawlingCoreService: CrawlingCoreService,
    private summaryGenerationService: SummaryGenerationService,
    private archiveOrchestratorService: ArchiveOrchestratorService,
    private notificationOrchestratorService: NotificationOrchestratorService,
    private noticeArchiveService: NoticeArchiveService,
    @Optional() private discordBridge: DiscordBridgeService,
  ) {
    this.summarySupport = new CrawlingSchedulerSummarySupport({
      cacheService: this.cacheService,
      noticeArchiveService: this.noticeArchiveService,
      summaryGenerationService: this.summaryGenerationService,
      logger: this.logger,
      discordBridge: this.discordBridge,
    });

    this.proposalRetrySupport = new CrawlingSchedulerProposalRetry({
      cacheService: this.cacheService,
      archiveOrchestratorService: this.archiveOrchestratorService,
      summaryGenerationService: this.summaryGenerationService,
      notificationOrchestratorService: this.notificationOrchestratorService,
      noticeArchiveService: this.noticeArchiveService,
      logger: this.logger,
      discordBridge: this.discordBridge,
    });
  }

  private getPendingWorkflowDeps() {
    return {
      isInitialized: this.isInitialized,
      logger: this.logger,
      discordBridge: this.discordBridge,
      crawlingCoreService: this.crawlingCoreService,
      archiveOrchestratorService: this.archiveOrchestratorService,
      notificationOrchestratorService: this.notificationOrchestratorService,
      summaryGenerationService: this.summaryGenerationService,
      noticeArchiveService: this.noticeArchiveService,
      cacheService: this.cacheService,
      proposalRetrySupport: this.proposalRetrySupport,
      runBackgroundTask: (taskName: string, task: () => Promise<void>) =>
        this.runBackgroundTask(taskName, task),
      isRetryableNetworkError,
    };
  }

  /**
   * Initializes the cache in the background on module startup.
   */
  async onModuleInit() {
    this.isInitialized = false;
    this.logger.log('Scheduling cache initialization in background...');

    void this.initializeCacheInBackground();
  }

  private async initializeCacheInBackground(): Promise<void> {
    logAndBridge({
      logger: this.logger,
      method: 'log',
      message: 'Initializing cache with recent legislative notices...',
      context: CrawlingSchedulerService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.LOG,
      bridgeMessage: 'Cache initialization started',
    });
    try {
      await this.initializeCache();
      logAndBridge({
        logger: this.logger,
        method: 'log',
        message: 'Cache initialization completed successfully',
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.LOG,
      });
    } catch (error) {
      logAndBridge({
        logger: this.logger,
        method: 'error',
        message: 'Failed to initialize cache:',
        loggerArgs: [error],
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.ERROR,
        bridgeMessage: `Cache initialization failed: ${(error as Error).message}`,
      });
    } finally {
      this.isInitialized = true;

      // Resume persisted proposalReason retry queue after startup.
      this.proposalRetrySupport.drainInBackground();
    }
  }

  async handleCron() {
    if (!this.isInitialized) {
      this.logger.warn('Cache not initialized yet, skipping cron job');
      return;
    }

    if (this.isProcessing) {
      logAndBridge({
        logger: this.logger,
        method: 'warn',
        message: 'Previous crawling process is still running, skipping...',
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.WARN,
      });
      return;
    }

    this.isProcessing = true;

    try {
      await this.performCrawlingAndNotification();
    } catch (error) {
      logAndBridge({
        logger: this.logger,
        method: 'error',
        message: 'Error during crawling process',
        loggerArgs: [error],
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.ERROR,
        bridgeMessage: `Crawling process failed: ${(error as Error).message}`,
      });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Drains the proposalReason retry queue from a dedicated cron trigger.
   * Keeps immutable snapshot policy by relying on append-only repair path.
   */
  async handleProposalReasonBackfillCron(): Promise<void> {
    if (!this.isInitialized) {
      this.logger.warn(
        'Cache not initialized yet, skipping proposalReason retry drain',
      );
      return;
    }

    const limit = APP_CONSTANTS.ARCHIVE_SYNC.SUMMARY_BACKFILL_BATCH_SIZE;
    const queueBefore = await this.proposalRetrySupport.getQueueLength();

    const candidates =
      await this.noticeArchiveService.getNsmProposalReasonRetryCandidates(
        limit,
      );

    for (const candidate of candidates) {
      await this.proposalRetrySupport.enqueue(candidate.notice, {
        billNo: candidate.billNo,
      });
    }

    const queueAfterSeed = await this.proposalRetrySupport.getQueueLength();
    this.logger.log(
      `proposalReason retry cron: queue before=${queueBefore}, seeded=${candidates.length}, queue after seed=${queueAfterSeed}`,
    );

    await this.proposalRetrySupport.drain();

    const queueAfterDrain = await this.proposalRetrySupport.getQueueLength();
    this.logger.log(
      `proposalReason retry cron: drain completed, queue after drain=${queueAfterDrain}`,
    );
  }

  /**
   * Returns true when scheduler is actively handling cron work.
   * By default includes background tasks launched after the fast path.
   */
  isBusy(options: { includeBackground?: boolean } = {}): boolean {
    const includeBackground = options.includeBackground ?? true;
    if (this.isProcessing) return true;
    if (includeBackground && this.activeBackgroundTasks.size > 0) return true;
    return false;
  }

  /**
   * Waits until scheduler fast-path and background tasks are fully idle.
   * Throws when timeout is exceeded.
   */
  async waitForIdle(timeoutMs = 10000, pollMs = 200): Promise<void> {
    const startedAt = Date.now();

    while (this.isBusy({ includeBackground: true })) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `crawling scheduler still busy after ${timeoutMs}ms (activeBackgroundTasks=${this.activeBackgroundTasks.size}, isProcessing=${this.isProcessing})`,
        );
      }

      await delayMs(pollMs);
    }
  }

  /** Snapshot for diagnostics (API/Discord/debug logs). */
  getExecutionState(): {
    isInitialized: boolean;
    isProcessing: boolean;
    activeBackgroundTaskCount: number;
    activeBackgroundTasks: string[];
  } {
    return {
      isInitialized: this.isInitialized,
      isProcessing: this.isProcessing,
      activeBackgroundTaskCount: this.activeBackgroundTasks.size,
      activeBackgroundTasks: Array.from(this.activeBackgroundTasks).sort(),
    };
  }

  /**
   * Runs a named background task exactly once at a time.
   * If the same task is already running, the new request is skipped.
   */
  private runBackgroundTask(taskName: string, task: () => Promise<void>): void {
    if (this.activeBackgroundTasks.has(taskName)) {
      LoggerUtils.debug(
        CrawlingSchedulerService.name,
        `Background task already running - skipping duplicate launch: ${taskName}`,
      );
      return;
    }

    this.activeBackgroundTasks.add(taskName);
    void task()
      .catch((error) => {
        this.logger.error(
          `Background task failed [${taskName}]: ${(error as Error).message}`,
        );
      })
      .finally(() => {
        this.activeBackgroundTasks.delete(taskName);
      });
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
    logAndBridge({
      logger: this.logger,
      method: 'log',
      message: `Archive has ${archivedCount} notices - loading cache from DB (no external crawl)`,
      context: CrawlingSchedulerService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.LOG,
      bridgeMessage: `Cache initialization: loading **${archivedCount}** notice(s) from archive DB`,
    });

    let notices: CachedNotice[];
    try {
      notices = await this.noticeArchiveService.getRecentNoticesForCache(
        APP_CONSTANTS.CACHE.MAX_SIZE,
      );
    } catch (error) {
      logAndBridge({
        logger: this.logger,
        method: 'warn',
        message: `Archive load failed, falling back to crawl: ${(error as Error).message}`,
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.WARN,
        bridgeMessage: `Cache init archive load failed, falling back to crawl: ${(error as Error).message}`,
      });
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
    logAndBridge({
      logger: this.logger,
      method: 'log',
      message: `Initialized Redis cache with ${notices.length} notices (from archive DB, no crawl)`,
      context: CrawlingSchedulerService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.VERBOSE,
      bridgeMessage: `Bootstrap cache loaded: **${notices.length}** notice(s) from archive DB`,
      metadata: { count: notices.length, source: 'archive' },
    });
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
    logAndBridge({
      logger: this.logger,
      method: 'log',
      message:
        'Archive is empty - crawling to populate cache (first-ever startup)',
      context: CrawlingSchedulerService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.LOG,
      bridgeMessage:
        'Cache initialization: archive is empty, crawling for initial data',
    });

    const crawledData = await this.crawlingCoreService.crawlAllPages();

    if (!crawledData || crawledData.length === 0) {
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
      logAndBridge({
        logger: this.logger,
        method: 'warn',
        message: `Summary enrichment failed during init, using raw crawled data: ${(error as Error).message}`,
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.WARN,
        bridgeMessage: `Summary enrichment failed during init: ${(error as Error).message}`,
      });
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
    logAndBridge({
      logger: this.logger,
      method: 'log',
      message: `Initialized Redis cache with ${noticesWithSummary.length} notices (crawled)`,
      context: CrawlingSchedulerService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.VERBOSE,
      bridgeMessage: `Bootstrap cache loaded: **${noticesWithSummary.length}** notice(s) stored in Redis`,
      metadata: { count: noticesWithSummary.length, source: 'crawl' },
    });
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
    const existingNoticeMap =
      this.summarySupport.buildNoticeMap(existingNotices);
    const maxCachedNum = existingNotices[0]?.num;

    const crawledData = await this.crawlingCoreService.crawlAllPages({
      stopBelowNum: maxCachedNum,
      delayMs: APP_CONSTANTS.ARCHIVE_SYNC.CRAWLER_CRON_DELAY_MS,
    });

    if (!crawledData || crawledData.length === 0) {
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
      logAndBridge({
        logger: this.logger,
        method: 'warn',
        message:
          'Redis unavailable - falling back to archive-based deduplication',
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.WARN,
        bridgeMessage:
          'Redis unavailable - falling back to archive-based deduplication for this cycle',
      });
    }

    const newNotices =
      await this.archiveOrchestratorService.filterAlreadyArchivedNotices(
        cacheDiffNotices,
      );

    logAndBridge({
      method: 'verbose',
      message: `crawl stats: crawled=${crawledData.length} cacheDiff=${cacheDiffNotices.length} new=${newNotices.length} cacheAvailable=${cacheAvailable}`,
      context: CrawlingSchedulerService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.VERBOSE,
      bridgeMessage: `Crawl stats - crawled: **${crawledData.length}**, cache diff: **${cacheDiffNotices.length}**, new: **${newNotices.length}**${cacheAvailable ? '' : ' *(cache fallback)*'}`,
      metadata: {
        totalCrawled: crawledData.length,
        cacheDiff: cacheDiffNotices.length,
        newAfterArchiveFilter: newNotices.length,
        cacheAvailable,
      },
    });

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
            this.summarySupport.resolveSummaryStatus(existingNotice.aiSummary),
        };
      }
      return {
        ...notice,
        aiSummary: null,
        aiSummaryStatus: 'not_requested' as const,
      };
    });
    await this.cacheService.updateCache(noticesWithExistingSummary);

    // If a bill was archived earlier from NSM (contentId=NULL) and now appears
    // in PAL with contentId, refresh that row in the background. Also run a
    // bounded periodic re-compare pass for already archived PAL notices so
    // title/proposal metadata drifts are captured as append-only diff events.
    const newNums = new Set(newNotices.map((n) => n.num));
    const alreadyArchivedWithContentId = crawledData.filter(
      (item) => !newNums.has(item.num) && item.contentId !== null,
    );
    if (alreadyArchivedWithContentId.length > 0) {
      this.runBackgroundTask('refresh-existing-pal-notices', async () => {
        await this.refreshExistingPalNoticesInBackground(
          alreadyArchivedWithContentId,
        );
      });
    }

    if (newNotices.length > 0) {
      logAndBridge({
        logger: this.logger,
        method: 'log',
        message: `Found ${newNotices.length} new legislative notices`,
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.LOG,
        bridgeMessage: `Found **${newNotices.length}** new legislative notice(s)`,
        metadata: {
          subjects: newNotices.slice(0, 5).map((n) => n.subject ?? n.num),
          total: newNotices.length,
        },
      });

      // ── Background path: AI summary → archiving → cache re-update → notifications ──
      // Runs independently after the isProcessing lock is released, so it never blocks the cron cycle.
      this.runBackgroundTask('process-new-notices', async () => {
        try {
          await this.processNewNoticesInBackground(
            newNotices,
            existingNoticeMap,
          );
        } catch (error) {
          logAndBridge({
            logger: this.logger,
            method: 'error',
            message: 'Background processing for new notices failed:',
            loggerArgs: [error],
            context: CrawlingSchedulerService.name,
            discordBridge: this.discordBridge,
            bridgeLevel: BridgeLogLevel.ERROR,
            bridgeMessage: `Background new notice processing failed: ${(error as Error).message}`,
          });
        }
      });
    } else {
      logAndBridge({
        method: 'verbose',
        message: `no new notices - cache refreshed count=${crawledData.length}`,
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.VERBOSE,
        bridgeMessage: `No new notices - cache refreshed with **${crawledData.length}** existing notice(s)`,
        metadata: { total: crawledData.length },
      });

      // ── Background path: retry summaries that failed to generate in a previous cycle ──
      this.runBackgroundTask('retry-unavailable-summaries', async () => {
        try {
          await this.retryUnavailableSummariesInBackground(
            noticesWithExistingSummary,
            existingNoticeMap,
          );
        } catch (error) {
          this.logger.warn(
            `Background summary retry failed: ${(error as Error).message}`,
          );
        }
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
      logAndBridge({
        logger: this.logger,
        method: 'error',
        message: `Summary enrichment failed for new notices, using raw data: ${(error as Error).message}`,
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.ERROR,
        bridgeMessage: `Summary enrichment failed: ${(error as Error).message}`,
      });
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
      logAndBridge({
        logger: this.logger,
        method: 'error',
        message: `Archive stage failed for new notices, proceeding with cache and notifications: ${(error as Error).message}`,
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.ERROR,
        bridgeMessage: `Archive stage failed: ${(error as Error).message}`,
      });
    }

    // Stage: Reconcile generated summaries against persisted summary_state.
    // Cache/notification payloads must not get ahead of DB durability.
    let persistedSummaryStates: Map<number, ArchiveSummaryState>;
    try {
      persistedSummaryStates =
        await this.noticeArchiveService.getSummaryStateByNoticeNums(
          newNoticesWithSummary.map((notice) => notice.num),
        );
    } catch (error) {
      this.logger.warn(
        `Failed to reload persisted summary states, suppressing in-memory-only summaries: ${(error as Error).message}`,
      );
      persistedSummaryStates = new Map();
    }

    const reconciledNoticesWithSummary = newNoticesWithSummary.map((notice) => {
      const persisted = persistedSummaryStates.get(notice.num);
      if (!persisted) {
        return {
          ...notice,
          aiSummary: null,
          aiSummaryStatus: 'not_requested' as const,
        };
      }

      const generatedStatus = notice.aiSummaryStatus ?? 'not_requested';
      const persistedStatus = persisted.aiSummaryStatus ?? 'not_requested';
      const generatedSummary = notice.aiSummary?.trim() || null;
      const persistedSummary = persisted.aiSummary?.trim() || null;

      if (
        generatedStatus !== persistedStatus ||
        generatedSummary !== persistedSummary
      ) {
        this.logger.warn(
          `Suppressed non-durable summary from cache for notice ${notice.num}: generated=${generatedStatus}, persisted=${persistedStatus}`,
        );
      }

      return {
        ...notice,
        aiSummary: persisted.aiSummary ?? null,
        aiSummaryStatus: persistedStatus,
      };
    });

    // Stage: Merge summaries into freshest cache snapshot (race-safe re-fetch)
    // Another cron cycle may have updated the cache while this background task was running,
    // so re-fetch the latest cache before merging the newly generated summaries.
    const freshCacheNotices = await this.cacheService.getRecentNotices(
      APP_CONSTANTS.CACHE.MAX_SIZE,
    );
    const newNoticeMap = this.summarySupport.buildNoticeMap(
      reconciledNoticesWithSummary,
    );
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
      finalNotices =
        await this.summarySupport.retryUnavailableSummariesFromPreviousCycle(
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
    logAndBridge({
      logger: this.logger,
      method: 'log',
      message: `Background processing complete: cache updated with summaries for ${newNotices.length} new notice(s)`,
      context: CrawlingSchedulerService.name,
      discordBridge: this.discordBridge,
      bridgeLevel: BridgeLogLevel.DEBUG,
      bridgeMessage: `Background processing complete: cache updated with summaries for **${newNotices.length}** new notice(s)`,
      metadata: { count: newNotices.length },
    });

    // Stage: Send notifications (already dispatched asynchronously)
    void this.notificationOrchestratorService
      .sendNotifications(reconciledNoticesWithSummary)
      .catch((error) => {
        logAndBridge({
          logger: this.logger,
          method: 'error',
          message: 'Background notification dispatch failed:',
          loggerArgs: [error],
          context: CrawlingSchedulerService.name,
          discordBridge: this.discordBridge,
          bridgeLevel: BridgeLogLevel.ERROR,
          bridgeMessage: 'Background notification dispatch failed',
        });
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
    await this.summarySupport.retryUnavailableSummariesInBackground(
      notices,
      existingNoticeMap,
    );
  }

  /**
   * Periodic (cron) NSM->PAL transition refresh.
   *
   * Finds archive rows that were previously created from NSM with
   * `contentId = NULL`, then re-archives them using PAL detail/source HTML
   * once PAL exposes a real contentId for the same notice number.
   */
  private async refreshExistingPalNoticesInBackground(
    itemsWithContentId: ITableData[],
  ): Promise<void> {
    const compareBatchLimit =
      APP_CONSTANTS.ARCHIVE_SYNC.SUMMARY_BACKFILL_BATCH_SIZE;
    const nullContentIdNums =
      await this.noticeArchiveService.getArchivedNullContentIdNums(
        itemsWithContentId.map((item) => item.num),
      );

    if (nullContentIdNums.size === 0) {
      return;
    }

    const toUpgrade = itemsWithContentId.filter((item) =>
      nullContentIdNums.has(item.num),
    );
    const toRecompare = itemsWithContentId
      .filter((item) => !nullContentIdNums.has(item.num))
      .slice(0, compareBatchLimit);

    if (toUpgrade.length === 0 && toRecompare.length === 0) {
      return;
    }

    const toCachedNotice = (item: ITableData): CachedNotice => {
      return {
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
      };
    };

    const upgraded =
      toUpgrade.length > 0
        ? await this.archiveOrchestratorService.archiveNotices(
            toUpgrade.map(toCachedNotice),
            { reason: 'nsm-pal-upgrade' },
          )
        : 0;

    if (upgraded > 0) {
      logAndBridge({
        logger: this.logger,
        method: 'log',
        message: `Periodic NSM->PAL archive refresh updated ${upgraded} bill(s)`,
        context: CrawlingSchedulerService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.DEBUG,
        bridgeMessage: `Periodic NSM->PAL archive refresh: upgraded **${upgraded}** bill(s)`,
        metadata: {
          upgraded,
          detected: toUpgrade.length,
          sampleNoticeNums: toUpgrade.slice(0, 10).map((item) => item.num),
        },
      });
    }

    if (toRecompare.length > 0) {
      await this.archiveOrchestratorService.archiveNotices(
        toRecompare.map(toCachedNotice),
        { reason: 'pal-recompare' },
      );
      this.logger.log(
        `Periodic PAL re-compare scanned ${toRecompare.length} archived notice(s)`,
      );
    }
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
    await handlePendingCronInternal(
      this.getPendingWorkflowDeps(),
      PENDING_CRAWL_MAX_RETRIES,
      PENDING_CRAWL_RETRY_BASE_MS,
    );
  }
}
