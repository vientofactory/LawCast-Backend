import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PalCrawl, type ITableData, type PalCrawlConfig } from 'pal-crawl';
import { CacheService } from './cache.service';
import {
  BatchProcessingOptions,
  BatchProcessingService,
} from './batch-processing.service';
import { APP_CONSTANTS } from '../config/app.config';
import { LoggerUtils } from '../utils/logger.utils';
import { type CacheInfo } from '../types/cache.types';

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

      // 초기 캐시 업데이트
      await this.cacheService.updateCache(crawledData);
      this.logger.log(
        `Initialized Redis cache with ${crawledData.length} notices`,
      );
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

      if (newNotices.length > 0) {
        this.logger.log(`Found ${newNotices.length} new legislative notices`);

        try {
          // 알림 전송 먼저 시도
          await this.sendNotifications(newNotices);

          // 알림 전송 성공 후 캐시 업데이트
          await this.cacheService.updateCache(crawledData);
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
            await this.cacheService.updateCache(crawledData);
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
  ): Promise<ITableData[]> {
    return await this.cacheService.getRecentNotices(limit);
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
}
