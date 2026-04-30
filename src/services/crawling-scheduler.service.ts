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
    void this.discordBridge.logEvent(
      BridgeLogLevel.LOG,
      CrawlingSchedulerService.name,
      'Cache initialization started',
    );
    try {
      await this.initializeCache();
      this.logger.log('Cache initialization completed successfully');
      void this.discordBridge.logEvent(
        BridgeLogLevel.LOG,
        CrawlingSchedulerService.name,
        'Cache initialization completed successfully',
      );
    } catch (error) {
      this.logger.error('Failed to initialize cache:', error);
      void this.discordBridge.logEvent(
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
      void this.discordBridge.logEvent(
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
      void this.discordBridge.logEvent(
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
    const crawledData = await this.crawlingCoreService.crawlData();

    if (!crawledData || crawledData.length === 0) {
      void this.discordBridge.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        'No data received from crawler during initialization',
      );
      this.logger.warn('No data received from crawler during initialization');
      return;
    }

    const archiveSummaryStates =
      await this.noticeArchiveService.getSummaryStateByNoticeNums(
        crawledData.map((notice) => notice.num),
      );

    const noticesWithSummary =
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

    await this.persistRetriedArchiveSummaryStates(
      noticesWithSummary,
      archiveSummaryStates,
    );

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
      void this.discordBridge.logEvent(
        BridgeLogLevel.VERBOSE,
        CrawlingSchedulerService.name,
        `Bootstrap archived **${missingArchiveNotices.length}** missing notice(s)`,
        { count: missingArchiveNotices.length },
      );
    }

    // 초기 캐시 업데이트
    await this.cacheService.updateCache(noticesWithSummary);
    this.logger.log(
      `Initialized Redis cache with ${noticesWithSummary.length} notices`,
    );
    void this.discordBridge.logEvent(
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
    const crawledData = await this.crawlingCoreService.crawlData();

    if (!crawledData || crawledData.length === 0) {
      this.logger.warn('No data received from crawler');
      void this.discordBridge.logEvent(
        BridgeLogLevel.WARN,
        CrawlingSchedulerService.name,
        'No data received from crawler',
      );
      return [];
    }

    // 새로운 입법예고 찾기
    const cacheDiffNotices =
      await this.cacheService.findNewNotices(crawledData);
    const newNotices =
      await this.archiveOrchestratorService.filterAlreadyArchivedNotices(
        cacheDiffNotices,
      );
    const existingNotices = await this.cacheService.getRecentNotices(1000);
    const existingNoticeMap = this.buildNoticeMap(existingNotices);

    void this.discordBridge.logEvent(
      BridgeLogLevel.VERBOSE,
      CrawlingSchedulerService.name,
      `Crawl stats — crawled: **${crawledData.length}**, cache diff: **${cacheDiffNotices.length}**, new: **${newNotices.length}**`,
      {
        totalCrawled: crawledData.length,
        cacheDiff: cacheDiffNotices.length,
        newAfterArchiveFilter: newNotices.length,
      },
    );

    if (newNotices.length > 0) {
      this.logger.log(`Found ${newNotices.length} new legislative notices`);
      void this.discordBridge.logEvent(
        BridgeLogLevel.LOG,
        CrawlingSchedulerService.name,
        `Found **${newNotices.length}** new legislative notice(s)`,
        {
          subjects: newNotices.slice(0, 5).map((n) => n.subject ?? n.num),
          total: newNotices.length,
        },
      );

      const archiveSummaryStates =
        await this.noticeArchiveService.getSummaryStateByNoticeNums(
          newNotices.map((notice) => notice.num),
        );

      const newNoticesWithSummary =
        await this.summaryGenerationService.enrichNoticesWithSummary(
          newNotices,
          existingNoticeMap,
          archiveSummaryStates,
        );

      await this.archiveOrchestratorService.archiveNotices(
        newNoticesWithSummary,
      );

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

      const noticesWithRetriedSummary =
        await this.retryUnavailableSummariesFromPreviousCycle(
          noticesWithSummary,
          existingNoticeMap,
        );

      await this.cacheService.updateCache(noticesWithRetriedSummary);
      this.logger.log(
        `Cache updated for ${newNotices.length} new notices; notification dispatch will continue in background`,
      );

      void this.notificationOrchestratorService
        .sendNotifications(newNoticesWithSummary)
        .catch((error) => {
          this.logger.error('Background notification dispatch failed:', error);
          void this.discordBridge.logEvent(
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

      const noticesWithRetriedSummary =
        await this.retryUnavailableSummariesFromPreviousCycle(
          noticesWithExistingSummary,
          existingNoticeMap,
        );

      await this.cacheService.updateCache(noticesWithRetriedSummary);
      void this.discordBridge.logEvent(
        BridgeLogLevel.VERBOSE,
        CrawlingSchedulerService.name,
        `No new notices — cache refreshed with **${crawledData.length}** existing notice(s)`,
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

      if (!previousState || previousState.aiSummaryStatus !== 'unavailable') {
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

    await Promise.all(
      changedRetriedNotices.map(async (notice) => {
        await this.noticeArchiveService.updateSummaryStateByNoticeNum(
          notice.num,
          notice.aiSummary ?? null,
          notice.aiSummaryStatus ?? 'not_requested',
        );
      }),
    );

    this.logger.log(
      `Persisted retried summary state for ${changedRetriedNotices.length} archived notices`,
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
    void this.discordBridge.logEvent(
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
    void this.discordBridge.logEvent(
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

    await Promise.all(
      changedRetriedNotices.map(async (notice) => {
        await this.noticeArchiveService.updateSummaryStateByNoticeNum(
          notice.num,
          notice.aiSummary ?? null,
          notice.aiSummaryStatus ?? 'not_requested',
        );
      }),
    );

    this.logger.log(
      `Persisted cron retried summary state for ${changedRetriedNotices.length} notices`,
    );

    return mergedNotices;
  }
}
