import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PalCrawl, type ITableData, type PalCrawlConfig } from 'pal-crawl';
import { CacheService } from './cache.service';
import { BatchProcessingService } from './batch-processing.service';
import { APP_CONSTANTS } from '../config/app.config';

@Injectable()
export class CrawlingService implements OnModuleInit {
  private readonly logger = new Logger(CrawlingService.name);
  private isProcessing = false;
  private isInitialized = false;
  private readonly crawlConfig: PalCrawlConfig;

  constructor(
    private cacheService: CacheService,
    private batchProcessingService: BatchProcessingService,
  ) {
    // pal-crawl v1.2.0의 새로운 설정 옵션 활용
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
      await this.initializeCache();
      this.isInitialized = true;
      this.logger.log('Cache initialization completed successfully');
    } catch (error) {
      this.logger.error('Failed to initialize cache:', error);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
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

      // 초기 캐시 업데이트 (새로운 알림 전송 없이)
      this.cacheService.initializeCache(crawledData);
      this.logger.log(`Initialized cache with ${crawledData.length} notices`);
    } catch (error) {
      this.logger.error('Failed to crawl data during initialization:', error);
      if (error.message?.includes('timeout')) {
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
      this.logger.debug(
        'Starting crawling process with enhanced configuration...',
      );
      const crawledData = await palCrawl.get();

      if (!crawledData || crawledData.length === 0) {
        this.logger.warn('No data received from crawler');
        return [];
      }

      this.logger.debug(
        `Successfully crawled ${crawledData.length} legislative notices`,
      );

      // 캐시 업데이트
      this.cacheService.updateCache(crawledData);

      // 새로운 입법예고 찾기
      const newNotices = this.cacheService.findNewNotices(crawledData);

      if (newNotices.length > 0) {
        this.logger.log(`Found ${newNotices.length} new legislative notices`);
        await this.sendNotifications(newNotices);
      } else {
        this.logger.debug('No new notices found');
      }

      return newNotices;
    } catch (error) {
      this.logger.error('Error during crawling process:', error);
      if (error.message?.includes('timeout')) {
        this.logger.error(
          'Crawling timeout - server may be slow or unreachable',
        );
      } else if (error.message?.includes('network')) {
        this.logger.error(
          'Network error during crawling - check internet connection',
        );
      }
      throw error;
    }
  }

  /**
   * 논블로킹 방식으로 알림 배치 처리를 시작
   */
  private async sendNotifications(notices: ITableData[]): Promise<void> {
    // 논블로킹 배치 처리 시작 (백그라운드에서 실행)
    await this.batchProcessingService.processNotificationBatch(notices, {
      concurrency: 5,
      timeout: 30000,
      retryCount: 3,
      retryDelay: 1000,
    });

    this.logger.log(
      `Started background notification processing for ${notices.length} notices`,
    );
  }

  /**
   * 캐시에서 최근 입법예고를 반환
   */
  getRecentNotices(
    limit: number = APP_CONSTANTS.CACHE.DEFAULT_LIMIT,
  ): ITableData[] {
    return this.cacheService.getRecentNotices(limit);
  }

  /**
   * 캐시 정보를 반환
   */
  getCacheInfo() {
    return this.cacheService.getCacheInfo();
  }
}
