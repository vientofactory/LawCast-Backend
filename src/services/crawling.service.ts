import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PalCrawl, type ITableData, type PalCrawlConfig } from 'pal-crawl';
import { CacheService } from './cache.service';
import {
  BatchProcessingOptions,
  BatchProcessingService,
} from './batch-processing.service';
import { APP_CONSTANTS } from '../config/app.config';
import { LoggerUtils } from '../utils/logger.utils';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';
import { type CacheInfo, type CachedNotice } from '../types/cache.types';

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
    this.logger.log('Initializing cache with recent legislative notices...');
    try {
      // 초기화 중 플래그 설정
      this.isInitialized = false;

      await this.initializeCache();

      // 초기화 완료 후 플래그 설정
      this.isInitialized = true;
      this.logger.log('Cache initialization completed successfully');
    } catch (error) {
      this.logger.error('Failed to initialize cache:', error);
      this.isInitialized = true;
      throw error;
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

      const noticesWithSummary = await this.enrichNoticesWithSummary(
        crawledData,
        new Map(),
        {
          logOllamaActivity: true,
          phase: 'init-cache',
        },
      );

      const summarizedCount = noticesWithSummary.filter(
        (notice) => !!notice.aiSummary,
      ).length;

      this.logOllama(
        `Summary generation completed: ${summarizedCount}/${noticesWithSummary.length}`,
      );

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
      const newNotices = await this.cacheService.findNewNotices(crawledData);
      const existingNotices = await this.cacheService.getRecentNotices(
        APP_CONSTANTS.CACHE.MAX_SIZE,
      );
      const summaryByNum = this.buildSummaryMap(existingNotices);

      if (newNotices.length > 0) {
        this.logger.log(`Found ${newNotices.length} new legislative notices`);

        const newNoticesWithSummary = await this.enrichNoticesWithSummary(
          newNotices,
          summaryByNum,
        );
        const newNoticeSummaryMap = this.buildSummaryMap(newNoticesWithSummary);
        const noticesWithSummary = crawledData.map((notice) => ({
          ...notice,
          aiSummary: newNoticeSummaryMap.get(notice.num) ?? null,
        }));

        try {
          // 알림 전송 먼저 시도
          await this.sendNotifications(newNoticesWithSummary);

          // 알림 전송 성공 후 캐시 업데이트
          await this.cacheService.updateCache(noticesWithSummary);
          this.logger.log(
            `Cache updated after successful notification for ${newNotices.length} notices`,
          );
        } catch (notificationError) {
          this.logger.error(
            'Notification sending failed, but updating cache anyway to prevent repeated notifications:',
            notificationError,
          );
          // 알림 실패 시에도 캐시 업데이트
          try {
            await this.cacheService.updateCache(noticesWithSummary);
            this.logger.log('Cache updated despite notification failure');
          } catch (cacheError) {
            this.logger.error('Cache update also failed:', cacheError);
          }
          throw notificationError;
        }
      } else {
        LoggerUtils.debugDev(CrawlingService.name, 'No new notices found');
        // 새 데이터가 없어도 전체 캐시는 업데이트 (기존 데이터 정렬 및 크기 관리)
        await this.cacheService.updateCache(crawledData);
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
  private async sendNotifications(notices: ITableData[]): Promise<void> {
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

      // 특정 배치 작업 완료 대기
      await this.batchProcessingService.waitForBatchJob(jobId);

      this.logger.log(
        `Notification batch processing completed for ${notices.length} notices`,
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
    return await this.cacheService.getRecentNotices(limit);
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

  private buildSummaryMap(notices: CachedNotice[]): Map<number, string> {
    return new Map(
      notices
        .filter((notice) => !!notice.aiSummary)
        .map((notice) => [notice.num, notice.aiSummary!.trim()]),
    );
  }

  private async enrichNoticesWithSummary(
    notices: ITableData[],
    existingSummaries: Map<number, string> = new Map(),
    options: { logOllamaActivity?: boolean; phase?: string } = {},
  ): Promise<CachedNotice[]> {
    const { logOllamaActivity = false, phase = 'runtime' } = options;

    return Promise.all(
      notices.map(async (notice, index) => {
        const cachedSummary = existingSummaries.get(notice.num);

        if (cachedSummary) {
          if (logOllamaActivity) {
            this.logOllama(
              `Skipping notice ${index + 1}/${notices.length} (cache hit: num=${notice.num})`,
              phase,
            );
          }

          return {
            ...notice,
            aiSummary: cachedSummary,
          };
        }

        const aiSummary = await this.generateSummaryForNotice(notice, {
          logOllamaActivity,
          phase,
          index,
          total: notices.length,
        });

        return {
          ...notice,
          aiSummary,
        };
      }),
    );
  }

  private async generateSummaryForNotice(
    notice: ITableData,
    options: {
      logOllamaActivity?: boolean;
      phase?: string;
      index?: number;
      total?: number;
    } = {},
  ): Promise<string | null> {
    const {
      logOllamaActivity = false,
      phase = 'runtime',
      index,
      total,
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

      return null;
    }

    try {
      const palCrawl = new PalCrawl(this.crawlConfig);
      const content = await palCrawl.getContent(notice.contentId);

      if (!content?.proposalReason?.trim()) {
        if (logOllamaActivity) {
          this.logOllama(
            `Skip summary ${progressLabel} (contentId=${notice.contentId}) - empty proposalReason`,
            phase,
          );
        }

        return null;
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

      return summary;
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
      return null;
    }
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
}
