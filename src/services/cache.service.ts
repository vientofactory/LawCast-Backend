import { Injectable, Logger, Inject, OnModuleDestroy } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { type ITableData } from 'pal-crawl';
import { APP_CONSTANTS } from '../config/app.config';
import { LoggerUtils } from '../utils/logger.utils';
import { type CacheInfo } from '../types/cache.types';

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly MAX_CACHE_SIZE = APP_CONSTANTS.CACHE.MAX_SIZE;
  private readonly CACHE_KEYS = APP_CONSTANTS.CACHE.KEYS;

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  /**
   * 모듈 종료 시 정리 작업
   */
  async onModuleDestroy() {
    try {
      await this.clearCache();
      LoggerUtils.logDev(
        CacheService.name,
        'Cache service destroyed and cleared',
      );
    } catch (error) {
      this.logger.error('Error during cache service destruction:', error);
    }
  }

  /**
   * 캐시된 최근 입법예고 목록을 반환합니다.
   */
  async getRecentNotices(
    limit: number = APP_CONSTANTS.CACHE.DEFAULT_LIMIT,
  ): Promise<ITableData[]> {
    try {
      const cachedNotices = await this.cacheManager.get<ITableData[]>(
        this.CACHE_KEYS.RECENT_NOTICES,
      );

      if (!cachedNotices || cachedNotices.length === 0) {
        LoggerUtils.logDev(CacheService.name, 'No cached notices found');
        return [];
      }

      const actualLimit = Math.min(limit, this.MAX_CACHE_SIZE);
      return cachedNotices.slice(0, actualLimit);
    } catch (error) {
      this.logger.error('Error getting cached notices:', error);
      return [];
    }
  }

  /**
   * 캐시를 초기화하거나 업데이트합니다.
   * 기존 데이터와 새 데이터를 병합하여 최신 순으로 유지합니다.
   */
  async updateCache(notices: ITableData[]): Promise<void> {
    try {
      // 최신 순으로 정렬
      const sortedNotices = [...notices].sort((a, b) => b.num - a.num);

      // 기존 캐시 데이터 가져오기
      const existingNotices =
        (await this.cacheManager.get<ITableData[]>(
          this.CACHE_KEYS.RECENT_NOTICES,
        )) || [];

      // 기존 데이터와 새 데이터를 병합
      const mergedNotices = [...sortedNotices, ...existingNotices];

      // 중복 제거 및 최신 순 정렬
      const uniqueNotices = mergedNotices
        .filter(
          (notice, index, self) =>
            index === self.findIndex((n) => n.num === notice.num),
        )
        .sort((a, b) => b.num - a.num)
        .slice(0, this.MAX_CACHE_SIZE);

      // 캐시 저장
      await this.cacheManager.set(
        this.CACHE_KEYS.RECENT_NOTICES,
        uniqueNotices,
        0,
      );

      LoggerUtils.logDev(
        CacheService.name,
        `Cache updated: ${uniqueNotices.length} notices stored`,
      );
    } catch (error) {
      this.logger.error('Error updating cache:', error);
      throw error;
    }
  }

  /**
   * 새로운 입법예고들을 찾습니다.
   */
  async findNewNotices(crawledData: ITableData[]): Promise<ITableData[]> {
    try {
      const existingNotices =
        (await this.cacheManager.get<ITableData[]>(
          this.CACHE_KEYS.RECENT_NOTICES,
        )) || [];

      if (existingNotices.length === 0) {
        LoggerUtils.logDev(
          CacheService.name,
          'Cache is empty, all crawled data considered new',
        );
        return crawledData;
      }

      // 기존 데이터의 num 집합 생성
      const existingNums = new Set(existingNotices.map((notice) => notice.num));

      // 새로운 데이터만 필터링 (num 기준)
      const newNotices = crawledData.filter(
        (item) => !existingNums.has(item.num),
      );

      LoggerUtils.logDev(
        CacheService.name,
        `Found ${newNotices.length} new notices out of ${crawledData.length} crawled (cache has ${existingNotices.length})`,
      );

      return newNotices;
    } catch (error) {
      this.logger.error('Error finding new notices:', error);
      LoggerUtils.logDev(
        CacheService.name,
        'Error in findNewNotices, returning empty array to prevent false notifications',
      );
      return [];
    }
  }

  /**
   * 캐시 정보를 반환합니다.
   */
  async getCacheInfo(): Promise<CacheInfo> {
    try {
      const cachedNotices =
        (await this.cacheManager.get<ITableData[]>(
          this.CACHE_KEYS.RECENT_NOTICES,
        )) || [];

      return {
        size: cachedNotices.length,
        lastUpdated: cachedNotices.length > 0 ? new Date() : null,
        maxSize: this.MAX_CACHE_SIZE,
        isInitialized: cachedNotices.length > 0,
      };
    } catch (error) {
      this.logger.error('Error getting cache info:', error);
      return {
        size: 0,
        lastUpdated: null,
        maxSize: this.MAX_CACHE_SIZE,
        isInitialized: false,
      };
    }
  }

  /**
   * 캐시를 완전히 초기화합니다.
   */
  async clearCache(): Promise<void> {
    try {
      await this.cacheManager.del(this.CACHE_KEYS.RECENT_NOTICES);
      LoggerUtils.logDev(CacheService.name, 'Redis cache cleared');
    } catch (error) {
      this.logger.error('Error clearing Redis cache:', error);
      throw error;
    }
  }

  /**
   * Redis 연결 상태 확인
   */
  async isRedisConnected(): Promise<boolean> {
    try {
      await this.cacheManager.set('health_check', 'ok');
      await this.cacheManager.del('health_check');
      return true;
    } catch (error) {
      this.logger.error('Redis connection check failed:', error);
      return false;
    }
  }

  /**
   * Redis 상태 및 성능 정보를 상세히 확인합니다
   */
  async getRedisStatus(): Promise<{
    connected: boolean;
    responseTime?: number;
    cacheInfo: CacheInfo;
    error?: string;
  }> {
    const startTime = Date.now();

    try {
      const testKey = `health_check_${Date.now()}`;
      await this.cacheManager.set(testKey, 'performance_test');
      const retrievedValue = await this.cacheManager.get(testKey);
      await this.cacheManager.del(testKey);

      const responseTime = Date.now() - startTime;
      const cacheInfo = await this.getCacheInfo();

      if (retrievedValue === 'performance_test') {
        LoggerUtils.logDev(
          CacheService.name,
          `Redis health check passed (${responseTime}ms)`,
        );

        return {
          connected: true,
          responseTime,
          cacheInfo,
        };
      } else {
        throw new Error('Redis value mismatch during health check');
      }
    } catch (error) {
      this.logger.error('Redis status check failed:', error);

      return {
        connected: false,
        responseTime: Date.now() - startTime,
        cacheInfo: {
          size: 0,
          lastUpdated: null,
          maxSize: this.MAX_CACHE_SIZE,
          isInitialized: false,
        },
        error: error.message || 'Unknown Redis error',
      };
    }
  }
}
