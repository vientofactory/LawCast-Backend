import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PalCrawl, type ITableData, type PalCrawlConfig } from 'pal-crawl';
import { CacheService } from './cache.service';
import {
  BatchProcessingOptions,
  BatchProcessingService,
} from './batch-processing.service';
import { APP_CONSTANTS } from '../config/app.config';
import { LoggerUtils } from '../utils/logger.utils';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';
import {
  type AISummaryStatus,
  type CacheInfo,
  type CachedNotice,
} from '../types/cache.types';
import { NoticeArchiveService } from './notice-archive.service';
import {
  type ArchiveHttpMetadata,
  type ArchiveSummaryState,
} from './notice-archive.service';

@Injectable()
export class CrawlingService implements OnModuleInit {
  private readonly logger = new Logger(CrawlingService.name);
  private readonly LOG_PREFIX = {
    OLLAMA: '[Ollama]',
  };
  private isProcessing = false;
  private isInitialized = false;
  private readonly crawlConfig: PalCrawlConfig;

  constructor(
    private cacheService: CacheService,
    private batchProcessingService: BatchProcessingService,
    private ollamaClientService: OllamaClientService,
    private noticeArchiveService: NoticeArchiveService,
  ) {
    this.crawlConfig = {
      userAgent: APP_CONSTANTS.CRAWLING.USER_AGENT,
      timeout: APP_CONSTANTS.CRAWLING.TIMEOUT,
      retryCount: APP_CONSTANTS.CRAWLING.RETRY_COUNT,
      customHeaders: APP_CONSTANTS.CRAWLING.HEADERS,
    };
  }

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
    try {
      await this.initializeCache();
      this.logger.log('Cache initialization completed successfully');
    } catch (error) {
      this.logger.error('Failed to initialize cache:', error);
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
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 초기 캐시 로드 (알림 전송 없이)
   */
  private async initializeCache(): Promise<void> {
    const palCrawl = new PalCrawl(this.crawlConfig);

    try {
      const crawledData = await palCrawl.get();

      if (!crawledData || crawledData.length === 0) {
        this.logger.warn('No data received from crawler during initialization');
        return;
      }

      this.logOllama(
        `Starting summary generation for ${crawledData.length} notices`,
      );

      const archiveSummaryStates =
        await this.noticeArchiveService.getSummaryStateByNoticeNums(
          crawledData.map((notice) => notice.num),
        );

      const noticesWithSummary = await this.enrichNoticesWithSummary(
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

      const summarizedCount = noticesWithSummary.filter(
        (notice) => !!notice.aiSummary,
      ).length;

      this.logOllama(
        `Summary generation completed: ${summarizedCount}/${noticesWithSummary.length}`,
      );

      const missingArchiveNotices =
        await this.filterAlreadyArchivedNotices(noticesWithSummary);

      if (missingArchiveNotices.length > 0) {
        await this.archiveNotices(missingArchiveNotices);
        this.logger.log(
          `Archived ${missingArchiveNotices.length} missing notices during bootstrap initialization`,
        );
      }

      // 초기 캐시 업데이트
      await this.cacheService.updateCache(noticesWithSummary);
      this.logger.log(
        `Initialized Redis cache with ${noticesWithSummary.length} notices`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to crawl data during initialization:', error);
      if (message.includes('timeout')) {
        this.logger.error(
          'Request timeout occurred - consider increasing timeout value',
        );
      }
      throw error;
    }
  }

  /**
   * 크롤링과 알림을 수행하는 메인 로직
   */
  private async performCrawlingAndNotification(): Promise<ITableData[]> {
    const palCrawl = new PalCrawl(this.crawlConfig);

    try {
      LoggerUtils.debugDev(
        CrawlingService.name,
        'Starting crawling process with enhanced configuration...',
      );
      const crawledData = await palCrawl.get();

      if (!crawledData || crawledData.length === 0) {
        this.logger.warn('No data received from crawler');
        return [];
      }

      LoggerUtils.debugDev(
        CrawlingService.name,
        `Successfully crawled ${crawledData.length} legislative notices`,
      );

      // 새로운 입법예고 찾기
      const cacheDiffNotices =
        await this.cacheService.findNewNotices(crawledData);
      const newNotices =
        await this.filterAlreadyArchivedNotices(cacheDiffNotices);
      const existingNotices = await this.cacheService.getRecentNotices(
        APP_CONSTANTS.CACHE.MAX_SIZE,
      );
      const existingNoticeMap = this.buildNoticeMap(existingNotices);

      if (newNotices.length > 0) {
        this.logger.log(`Found ${newNotices.length} new legislative notices`);

        const newNoticesWithSummary = await this.enrichNoticesWithSummary(
          newNotices,
          existingNoticeMap,
          new Map(),
        );

        await this.archiveNotices(newNoticesWithSummary);

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
            aiSummaryStatus: 'not_requested' as AISummaryStatus,
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

        void this.sendNotifications(newNoticesWithSummary).catch((error) => {
          this.logger.error('Background notification dispatch failed:', error);
        });
      } else {
        LoggerUtils.debugDev(CrawlingService.name, 'No new notices found');
        // 새 데이터가 없어도 기존 요약 상태를 보존하며 전체 캐시 업데이트
        const noticesWithExistingSummary = crawledData.map((notice) => {
          const existingNotice = existingNoticeMap.get(notice.num);

          if (!existingNotice) {
            return {
              ...notice,
              aiSummary: null,
              aiSummaryStatus: 'not_requested' as AISummaryStatus,
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
      }

      return newNotices;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('Error during crawling process:', error);
      if (message.includes('timeout')) {
        this.logger.error(
          'Crawling timeout - server may be slow or unreachable',
        );
      } else if (message.includes('network')) {
        this.logger.error(
          'Network error during crawling - check internet connection',
        );
      }
      throw error;
    }
  }

  /**
   * 알림 배치 처리를 실행하고 완료를 기다림
   */
  private async sendNotifications(notices: CachedNotice[]): Promise<void> {
    try {
      // 대량 알림의 경우 배치 크기 제한 적용
      const options: BatchProcessingOptions = {
        concurrency: 5,
        timeout: 30000,
        retryCount: 3,
        retryDelay: 1000,
      };

      // 50개 이상의 알림이 있는 경우 배치 크기 제한 적용
      if (notices.length > 50) {
        options.batchSize = 50;
        this.logger.log(
          `Large notification batch detected (${notices.length} notices), applying batch size limit of 50`,
        );
      }

      // 배치 처리 시작하고 jobId 받기
      const jobId = await this.batchProcessingService.processNotificationBatch(
        notices,
        options,
      );

      this.logger.log(
        `Started notification batch processing for ${notices.length} notices (job: ${jobId})`,
      );

      this.logger.log(
        `Notification batch processing is running asynchronously for ${notices.length} notices`,
      );
    } catch (error) {
      this.logger.error('Notification batch processing failed:', error);
      throw error;
    }
  }

  /**
   * 캐시에서 최근 입법예고를 반환
   */
  async getRecentNotices(
    limit: number = APP_CONSTANTS.CACHE.DEFAULT_LIMIT,
  ): Promise<CachedNotice[]> {
    const safeLimit = Math.min(
      APP_CONSTANTS.CACHE.MAX_SIZE,
      Math.max(APP_CONSTANTS.API.PAGINATION.MIN_LIMIT, limit),
    );

    const cachedNotices = await this.cacheService.getRecentNotices(
      APP_CONSTANTS.CACHE.MAX_SIZE,
    );

    if (cachedNotices.length === 0) {
      return [];
    }

    const archiveStartedAtMap =
      await this.noticeArchiveService.getArchiveStartedAtByNoticeNums(
        cachedNotices.map((notice) => notice.num),
      );

    const sorted = [...cachedNotices].sort((left, right) => {
      const leftTime = archiveStartedAtMap.get(left.num)?.getTime() ?? 0;
      const rightTime = archiveStartedAtMap.get(right.num)?.getTime() ?? 0;

      if (rightTime !== leftTime) {
        return rightTime - leftTime;
      }

      return right.num - left.num;
    });

    return sorted.slice(0, safeLimit);
  }

  async getNoticeDetail(noticeNum: number): Promise<{
    notice: CachedNotice;
    originalContent: {
      contentId: string;
      title: string;
      proposalReason: string;
    };
  }> {
    const notices = await this.cacheService.getRecentNotices(
      APP_CONSTANTS.CACHE.MAX_SIZE,
    );
    const notice = notices.find((item) => item.num === noticeNum);

    if (!notice) {
      throw new NotFoundException(
        `의안번호 ${noticeNum}에 해당하는 입법예고를 찾을 수 없습니다.`,
      );
    }

    if (!notice.contentId) {
      throw new NotFoundException(
        `의안번호 ${noticeNum}의 원문 정보를 조회할 수 없습니다.`,
      );
    }

    try {
      const palCrawl = new PalCrawl(this.crawlConfig);
      const content = await palCrawl.getContent(notice.contentId);
      const proposalReason = content?.proposalReason?.trim();

      if (!proposalReason) {
        throw new NotFoundException(
          `의안번호 ${noticeNum}의 제안이유 및 주요내용 원문이 비어 있습니다.`,
        );
      }

      return {
        notice,
        originalContent: {
          contentId: notice.contentId,
          title: content?.title?.trim() || notice.subject,
          proposalReason,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to fetch original content for notice ${noticeNum}: ${message}`,
      );
      throw new ServiceUnavailableException(
        '원문 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
      );
    }
  }

  private async filterAlreadyArchivedNotices<T extends { num: number }>(
    notices: T[],
  ): Promise<T[]> {
    if (notices.length === 0) {
      return [];
    }

    const existingNoticeNums =
      await this.noticeArchiveService.getExistingNoticeNumSet(
        notices.map((notice) => notice.num),
      );

    return notices.filter((notice) => !existingNoticeNums.has(notice.num));
  }

  private async archiveNotices(notices: CachedNotice[]): Promise<void> {
    if (notices.length === 0) {
      return;
    }

    const palCrawl = new PalCrawl(this.crawlConfig);
    const concurrency = 5;

    for (let i = 0; i < notices.length; i += concurrency) {
      const chunk = notices.slice(i, i + concurrency);

      await Promise.all(
        chunk.map(async (notice) => {
          let proposalReason = '';
          let sourceTitle: string | null = notice.subject;
          let sourceHtml: string | null = null;
          let sourceHtmlSha256: string | null = null;
          let httpMetadata: ArchiveHttpMetadata | null = null;
          const archivedAt = new Date();

          if (notice.contentId) {
            try {
              const content = await palCrawl.getContent(notice.contentId);
              proposalReason = content?.proposalReason?.trim() || '';
              sourceTitle = content?.title?.trim() || notice.subject;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              this.logger.warn(
                `Failed to fetch original content for archive notice ${notice.num}: ${message}`,
              );
            }
          }

          try {
            const sourceCapture = await this.captureNoticePageSource(
              notice.link,
            );
            sourceHtml = sourceCapture.html;
            sourceHtmlSha256 = sourceCapture.sha256;
            httpMetadata = sourceCapture.httpMetadata;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `Failed to capture source HTML for archive notice ${notice.num}: ${message}`,
            );
          }

          try {
            await this.noticeArchiveService.upsertNoticeArchive(notice, {
              proposalReason,
              title: sourceTitle,
              sourceHtml,
              htmlSha256: sourceHtmlSha256,
              archivedAt,
              httpMetadata,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger.error(
              `Failed to archive notice ${notice.num}: ${message}`,
              error,
            );
          }
        }),
      );
    }
  }

  private buildNoticeMap(notices: CachedNotice[]): Map<number, CachedNotice> {
    return new Map(notices.map((notice) => [notice.num, notice]));
  }

  private resolveSummaryStatus(summary?: string | null): AISummaryStatus {
    return summary?.trim() ? 'ready' : 'unavailable';
  }

  private async enrichNoticesWithSummary(
    notices: ITableData[],
    existingNotices: Map<number, CachedNotice> = new Map(),
    archiveSummaryStates: Map<number, ArchiveSummaryState> = new Map(),
    options: {
      logOllamaActivity?: boolean;
      phase?: string;
      retryUnavailableArchiveSummary?: boolean;
    } = {},
  ): Promise<CachedNotice[]> {
    const {
      logOllamaActivity = false,
      phase = 'runtime',
      retryUnavailableArchiveSummary = false,
    } = options;

    const summaryConcurrency = APP_CONSTANTS.CRAWLING.SUMMARY_CONCURRENCY;
    const palCrawl = new PalCrawl(this.crawlConfig);

    return this.mapWithConcurrency(
      notices,
      summaryConcurrency,
      async (notice, index) => {
        const existingNotice = existingNotices.get(notice.num);
        const cachedSummary = existingNotice?.aiSummary;

        if (cachedSummary?.trim()) {
          if (logOllamaActivity) {
            this.logOllama(
              `Skipping notice ${index + 1}/${notices.length} (cache hit: num=${notice.num})`,
              phase,
            );
          }

          return {
            ...notice,
            aiSummary: cachedSummary,
            aiSummaryStatus: 'ready',
          };
        }

        const archivedSummaryState = archiveSummaryStates.get(notice.num);

        if (archivedSummaryState) {
          if (
            retryUnavailableArchiveSummary &&
            archivedSummaryState.aiSummaryStatus === 'unavailable'
          ) {
            if (logOllamaActivity) {
              this.logOllama(
                `Retry summary ${index + 1}/${notices.length} (archive unavailable: num=${notice.num})`,
                phase,
              );
            }

            const retryResult = await this.generateSummaryForNotice(notice, {
              logOllamaActivity,
              phase,
              index,
              total: notices.length,
              palCrawl,
            });

            return {
              ...notice,
              aiSummary: retryResult.aiSummary,
              aiSummaryStatus: retryResult.aiSummaryStatus,
            };
          }

          if (logOllamaActivity) {
            this.logOllama(
              `Skipping notice ${index + 1}/${notices.length} (archive hit: num=${notice.num})`,
              phase,
            );
          }

          return {
            ...notice,
            aiSummary: archivedSummaryState.aiSummary,
            aiSummaryStatus: archivedSummaryState.aiSummaryStatus,
          };
        }

        const summaryResult = await this.generateSummaryForNotice(notice, {
          logOllamaActivity,
          phase,
          index,
          total: notices.length,
          palCrawl,
        });

        return {
          ...notice,
          aiSummary: summaryResult.aiSummary,
          aiSummaryStatus: summaryResult.aiSummaryStatus,
        };
      },
    );
  }

  private async generateSummaryForNotice(
    notice: ITableData | CachedNotice,
    options: {
      logOllamaActivity?: boolean;
      phase?: string;
      index?: number;
      total?: number;
      palCrawl?: PalCrawl;
    } = {},
  ): Promise<{ aiSummary: string | null; aiSummaryStatus: AISummaryStatus }> {
    const {
      logOllamaActivity = false,
      phase = 'runtime',
      index,
      total,
      palCrawl = new PalCrawl(this.crawlConfig),
    } = options;

    const progressLabel =
      typeof index === 'number' && typeof total === 'number'
        ? `${index + 1}/${total}`
        : '?/?';

    if (!notice.contentId) {
      if (logOllamaActivity) {
        this.logOllama(
          `Skip summary ${progressLabel} (num=${notice.num}) - no contentId`,
          phase,
        );
      }

      return {
        aiSummary: null,
        aiSummaryStatus: 'not_supported',
      };
    }

    try {
      const content = await palCrawl.getContent(notice.contentId);

      if (!content?.proposalReason?.trim()) {
        if (logOllamaActivity) {
          this.logOllama(
            `Skip summary ${progressLabel} (contentId=${notice.contentId}) - empty proposalReason`,
            phase,
          );
        }

        return {
          aiSummary: null,
          aiSummaryStatus: 'not_supported',
        };
      }

      if (logOllamaActivity) {
        this.logOllama(
          `Request summary ${progressLabel} (contentId=${notice.contentId})`,
          phase,
        );
      }

      const summary = await this.ollamaClientService.summarizeProposal(
        content.title,
        content.proposalReason,
      );

      if (logOllamaActivity) {
        this.logOllama(
          `Response summary ${progressLabel} (contentId=${notice.contentId}, success=${!!summary})`,
          phase,
        );
      }

      return {
        aiSummary: summary,
        aiSummaryStatus: summary ? 'ready' : 'unavailable',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (logOllamaActivity) {
        this.warnOllama(
          `Summary failed ${progressLabel} (contentId=${notice.contentId}): ${message}`,
          phase,
        );
      }

      this.logger.warn(
        `Failed to generate summary for contentId ${notice.contentId}: ${message}`,
      );
      return {
        aiSummary: null,
        aiSummaryStatus: 'unavailable',
      };
    }
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

    await this.mapWithConcurrency(changedRetriedNotices, 5, async (notice) => {
      await this.noticeArchiveService.updateSummaryStateByNoticeNum(
        notice.num,
        notice.aiSummary ?? null,
        notice.aiSummaryStatus ?? 'not_requested',
      );
    });

    this.logOllama(
      `Persisted retried summary state for ${changedRetriedNotices.length} archived notices`,
      'init-cache',
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

    this.logOllama(
      `Retrying unavailable summaries for ${retryCandidates.length} notices`,
      'cron',
    );

    const retryResults = await this.mapWithConcurrency(
      retryCandidates,
      APP_CONSTANTS.CRAWLING.SUMMARY_CONCURRENCY,
      async (notice, index) => {
        const summaryResult = await this.generateSummaryForNotice(notice, {
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
      },
    );

    const retryResultMap = new Map(
      retryResults.map((result) => [result.num, result]),
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

    await this.mapWithConcurrency(changedRetriedNotices, 5, async (notice) => {
      await this.noticeArchiveService.updateSummaryStateByNoticeNum(
        notice.num,
        notice.aiSummary ?? null,
        notice.aiSummaryStatus ?? 'not_requested',
      );
    });

    this.logOllama(
      `Persisted cron retried summary state for ${changedRetriedNotices.length} notices`,
      'cron',
    );

    return mergedNotices;
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const limit = Math.max(1, concurrency);
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= items.length) {
          return;
        }

        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => worker()),
    );

    return results;
  }

  /**
   * 캐시 정보를 반환
   */
  async getCacheInfo(): Promise<CacheInfo> {
    return await this.cacheService.getCacheInfo();
  }

  /**
   * Redis 연결 상태 확인
   */
  async isRedisConnected(): Promise<boolean> {
    return await this.cacheService.isRedisConnected();
  }

  /**
   * Redis 상태 및 성능 정보를 상세히 확인
   */
  async getRedisStatus(): Promise<{
    connected: boolean;
    responseTime?: number;
    cacheInfo: CacheInfo;
    error?: string;
  }> {
    return await this.cacheService.getRedisStatus();
  }

  private getOllamaPrefix(phase?: string): string {
    if (!phase) {
      return this.LOG_PREFIX.OLLAMA;
    }

    return `${this.LOG_PREFIX.OLLAMA}[${phase}]`;
  }

  private logOllama(message: string, phase?: string): void {
    this.logger.log(`${this.getOllamaPrefix(phase)} ${message}`);
  }

  private warnOllama(message: string, phase?: string): void {
    this.logger.warn(`${this.getOllamaPrefix(phase)} ${message}`);
  }

  private computeSha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  private async captureNoticePageSource(link: string): Promise<{
    html: string;
    sha256: string;
    httpMetadata: ArchiveHttpMetadata;
  }> {
    const response = await globalThis.fetch(link, {
      method: 'GET',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': APP_CONSTANTS.CRAWLING.USER_AGENT,
      },
      redirect: 'follow',
    });

    const html = await response.text();

    if (!html.trim()) {
      throw new Error('Captured HTML is empty');
    }

    return {
      html,
      sha256: this.computeSha256(html),
      httpMetadata: {
        requestUrl: link,
        responseUrl: response.url,
        fetchedAt: new Date().toISOString(),
        statusCode: response.status,
        contentType: response.headers.get('content-type') || undefined,
        etag: response.headers.get('etag') || undefined,
        lastModified: response.headers.get('last-modified') || undefined,
      },
    };
  }
}
