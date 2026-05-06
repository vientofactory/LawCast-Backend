import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { type ITableData } from 'pal-crawl';
import { type CachedNotice } from '../types/cache.types';
import { CacheService } from './cache.service';
import { CrawlingCoreService } from './crawling-core.service';
import { SummaryGenerationService } from './summary-generation.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { NotificationOrchestratorService } from './notification-orchestrator.service';
import {
  NoticeArchiveService,
  type ArchiveSummaryState,
} from './notice-archive.service';
import { APP_CONSTANTS } from '../config/app.config';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';

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
   * 서버 시작 시 초기 데이터 캐싱
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
   * 초기 캐시 로드 (알림 전송 없이)
   */
  private async initializeCache(): Promise<void> {
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

    // Stage 1: Archive summary states — fallback to empty map on DB failure
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

    // Stage 2: AI summary enrichment — fallback to raw notices on Ollama/crawl failure
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

    // Stage 3: Persist retried summary states — log and continue on failure
    try {
      await this.persistRetriedArchiveSummaryStates(
        noticesWithSummary,
        archiveSummaryStates,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to persist retried summary states during init: ${(error as Error).message}`,
      );
    }

    // Stage 4: Archive missing notices — log and continue on failure
    try {
      const missingArchiveNotices =
        await this.archiveOrchestratorService.filterAlreadyArchivedNotices(
          noticesWithSummary,
        );

      if (missingArchiveNotices.length > 0) {
        await this.archiveOrchestratorService.archiveNotices(
          missingArchiveNotices,
        );
        this.logger.log(
          `Archived ${missingArchiveNotices.length} missing notices during bootstrap initialization`,
        );
        void this.discordBridge?.logEvent(
          BridgeLogLevel.VERBOSE,
          CrawlingSchedulerService.name,
          `Bootstrap archived **${missingArchiveNotices.length}** missing notice(s)`,
          { count: missingArchiveNotices.length },
        );
      }
    } catch (error) {
      this.logger.error(
        `Archive stage failed during init, proceeding with cache update: ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.ERROR,
        CrawlingSchedulerService.name,
        `Bootstrap archive stage failed: ${(error as Error).message}`,
      );
    }

    // Stage 5: Cache update — always runs with whatever data we have
    await this.cacheService.updateCache(noticesWithSummary);
    this.logger.log(
      `Initialized Redis cache with ${noticesWithSummary.length} notices`,
    );
    void this.discordBridge?.logEvent(
      BridgeLogLevel.VERBOSE,
      CrawlingSchedulerService.name,
      `Bootstrap cache loaded: **${noticesWithSummary.length}** notice(s) stored in Redis`,
      { count: noticesWithSummary.length },
    );
  }

  /**
   * 크롤링과 알림을 수행하는 메인 로직
   */
  private async performCrawlingAndNotification(): Promise<ITableData[]> {
    // 기존 캐시를 먼저 조회한다.
    // - existingNoticeMap: 요약 상태 보존에 사용
    // - maxCachedNum: crawlAllPages의 early-exit 기준점 (최신 num 이하 페이지 스킵)
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

    // 새로운 입법예고 찾기.
    // Redis 장애 시 cacheDiffNotices = crawledData 전체로 폴백 -> archive dedup이 최종 가드 역할.
    let cacheDiffNotices: ITableData[];
    let cacheAvailable = true;
    try {
      cacheDiffNotices = await this.cacheService.findNewNotices(crawledData);
    } catch {
      cacheAvailable = false;
      cacheDiffNotices = crawledData;
      this.logger.warn(
        'Redis unavailable — falling back to archive-based deduplication',
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        'Redis unavailable — falling back to archive-based deduplication for this cycle',
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

      // Stage: Archive summary states — fallback to empty map on DB failure
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

      // Stage: AI summary enrichment — fallback to raw notices on Ollama/crawl failure
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

      // Stage: Archive — log and continue so cache + notifications are never blocked
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

      const newNoticeMap = this.buildNoticeMap(newNoticesWithSummary);
      const noticesWithSummary = crawledData.map((notice) => {
        const newNotice = newNoticeMap.get(notice.num);
        if (newNotice) {
          return {
            ...notice,
            aiSummary: newNotice.aiSummary ?? null,
            aiSummaryStatus: newNotice.aiSummaryStatus ?? 'not_requested',
          };
        }

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

      // Stage: Retry unavailable summaries — fallback to current notices on failure
      let noticesWithRetriedSummary: CachedNotice[];
      try {
        noticesWithRetriedSummary =
          await this.retryUnavailableSummariesFromPreviousCycle(
            noticesWithSummary,
            existingNoticeMap,
          );
      } catch (error) {
        this.logger.warn(
          `Unavailable summary retry failed, using current notices: ${(error as Error).message}`,
        );
        noticesWithRetriedSummary = noticesWithSummary;
      }

      await this.cacheService.updateCache(noticesWithRetriedSummary);
      this.logger.log(
        `Cache updated for ${newNotices.length} new notices; notification dispatch will continue in background`,
      );

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
    } else {
      // 새 데이터가 없어도 기존 요약 상태를 보존하며 전체 캐시 업데이트
      const noticesWithExistingSummary = crawledData.map((notice) => {
        const existingNotice = existingNoticeMap.get(notice.num);

        if (!existingNotice) {
          return {
            ...notice,
            aiSummary: null,
            aiSummaryStatus: 'not_requested' as const,
          };
        }

        return {
          ...notice,
          aiSummary: existingNotice.aiSummary ?? null,
          aiSummaryStatus:
            existingNotice.aiSummaryStatus ??
            this.resolveSummaryStatus(existingNotice.aiSummary),
        };
      });

      // Stage: Retry unavailable summaries — fallback to current notices on failure
      let noticesWithRetriedSummary: CachedNotice[];
      try {
        noticesWithRetriedSummary =
          await this.retryUnavailableSummariesFromPreviousCycle(
            noticesWithExistingSummary,
            existingNoticeMap,
          );
      } catch (error) {
        this.logger.warn(
          `Unavailable summary retry failed, using current notices: ${(error as Error).message}`,
        );
        noticesWithRetriedSummary = noticesWithExistingSummary;
      }

      await this.cacheService.updateCache(noticesWithRetriedSummary);
      void this.discordBridge?.logEvent(
        BridgeLogLevel.VERBOSE,
        CrawlingSchedulerService.name,
        `No new notices - cache refreshed with **${crawledData.length}** existing notice(s)`,
        { total: crawledData.length },
      );
    }

    return newNotices;
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
}
