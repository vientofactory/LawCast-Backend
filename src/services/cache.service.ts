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
  private readonly CACHE_TTL = APP_CONSTANTS.CACHE.TTL;

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  /**
   * 모듈 종료 시 정리 작업
   */
  async onModuleDestroy() {
    try {
      await this.clearCache();
      LoggerUtils.logDev(this.logger, 'Cache service destroyed and cleared');
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

      if (!cachedNotices) {
        LoggerUtils.logDev(this.logger, 'No cached notices found');
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
   * 초기화용 캐시 업데이트 (알림 없이)
   */
  async initializeCache(allNotices: ITableData[]): Promise<void> {
    try {
      // 최신 순으로 정렬 (num이 높을수록 최신)
      const sortedNotices = [...allNotices].sort((a, b) => b.num - a.num);

      // 최대 캐시 크기만큼만 저장
      const limitedNotices = sortedNotices.slice(0, this.MAX_CACHE_SIZE);

      // Redis에 캐시 저장
      await Promise.all([
        this.cacheManager.set(
          this.CACHE_KEYS.RECENT_NOTICES,
          limitedNotices,
          this.CACHE_TTL.NOTICES,
        ),
        this.updateCacheInfo({
          size: limitedNotices.length,
          lastUpdated: new Date(),
          maxSize: this.MAX_CACHE_SIZE,
          isInitialized: true,
        }),
        // 중복 체크를 위한 num 집합 저장
        this.cacheManager.set(
          this.CACHE_KEYS.NEW_NOTICES_SET,
          new Set(limitedNotices.map((notice) => notice.num)),
          this.CACHE_TTL.NOTICES,
        ),
      ]);

      LoggerUtils.logDev(
        this.logger,
        `Redis cache initialized with ${limitedNotices.length} notices`,
      );
    } catch (error) {
      this.logger.error('Error initializing Redis cache:', error);
      throw error;
    }
  }

  /**
   * 새로운 데이터로 캐시를 업데이트합니다.
   * 기존 캐시와 새 데이터를 병합하여 최신 순으로 유지합니다.
   */
  async updateCache(newNotices: ITableData[]): Promise<void> {
    try {
      const cacheInfo = await this.getCacheInfo();

      if (!cacheInfo.isInitialized) {
        // 초기화되지 않은 상태라면 초기화 메서드 사용
        await this.initializeCache(newNotices);
        return;
      }

      // 새로운 데이터를 최신 순으로 정렬 (num이 높을수록 최신)
      const sortedNewNotices = [...newNotices].sort((a, b) => b.num - a.num);

      // 기존 캐시된 데이터 가져오기
      const [existingNotices, existingNumsSet] = await Promise.all([
        this.cacheManager.get<ITableData[]>(this.CACHE_KEYS.RECENT_NOTICES) ||
          [],
        this.cacheManager.get<Set<number>>(this.CACHE_KEYS.NEW_NOTICES_SET) ||
          new Set(),
      ]);

      // 새로운 항목들만 필터링 (기존에 없는 것들)
      const actuallyNewNotices = sortedNewNotices.filter(
        (notice) => !existingNumsSet.has(notice.num),
      );

      if (actuallyNewNotices.length === 0) {
        LoggerUtils.logDev(this.logger, 'No new notices to add to cache');
        return;
      }

      // 기존 캐시와 새 데이터를 병합
      const mergedNotices = [...actuallyNewNotices, ...existingNotices];

      // 전체를 다시 최신 순으로 정렬하고 최대 캐시 크기만큼만 유지
      const finalNotices = mergedNotices
        .sort((a, b) => b.num - a.num)
        .slice(0, this.MAX_CACHE_SIZE);

      // 업데이트된 num 집합 생성
      const updatedNumsSet = new Set(finalNotices.map((notice) => notice.num));

      // Redis에 업데이트된 데이터 저장
      await Promise.all([
        this.cacheManager.set(
          this.CACHE_KEYS.RECENT_NOTICES,
          finalNotices,
          this.CACHE_TTL.NOTICES,
        ),
        this.cacheManager.set(
          this.CACHE_KEYS.NEW_NOTICES_SET,
          updatedNumsSet,
          this.CACHE_TTL.NOTICES,
        ),
        this.updateCacheInfo({
          size: finalNotices.length,
          lastUpdated: new Date(),
          maxSize: this.MAX_CACHE_SIZE,
          isInitialized: true,
        }),
      ]);

      LoggerUtils.logDev(
        this.logger,
        `Redis cache updated: ${actuallyNewNotices.length} new notices added, total ${finalNotices.length} notices`,
      );
    } catch (error) {
      this.logger.error('Error updating Redis cache:', error);
      throw error;
    }
  }

  /**
   * 새로운 입법예고들을 찾습니다.
   */
  async findNewNotices(crawledData: ITableData[]): Promise<ITableData[]> {
    try {
      const cacheInfo = await this.getCacheInfo();

      if (!cacheInfo.isInitialized) {
        // 초기화되지 않은 상태에서는 새로운 항목이 없다고 반환
        LoggerUtils.logDev(
          this.logger,
          'Cache not initialized, no new notices',
        );
        return [];
      }

      const existingNumsSet =
        (await this.cacheManager.get<Set<number>>(
          this.CACHE_KEYS.NEW_NOTICES_SET,
        )) || new Set();

      const newNotices = crawledData.filter(
        (item) => !existingNumsSet.has(item.num),
      );

      LoggerUtils.logDev(
        this.logger,
        `Found ${newNotices.length} new notices out of ${crawledData.length} crawled`,
      );

      return newNotices;
    } catch (error) {
      this.logger.error('Error finding new notices:', error);
      return [];
    }
  }

  /**
   * 캐시 정보를 반환합니다.
   */
  async getCacheInfo(): Promise<CacheInfo> {
    try {
      const cacheInfo = await this.cacheManager.get<CacheInfo>(
        this.CACHE_KEYS.CACHE_INFO,
      );

      if (!cacheInfo) {
        // 기본값 반환
        const defaultInfo: CacheInfo = {
          size: 0,
          lastUpdated: null,
          maxSize: this.MAX_CACHE_SIZE,
          isInitialized: false,
        };

        // 기본값을 캐시에 저장
        await this.cacheManager.set(
          this.CACHE_KEYS.CACHE_INFO,
          defaultInfo,
          this.CACHE_TTL.CACHE_INFO,
        );

        return defaultInfo;
      }

      return cacheInfo;
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
   * 캐시 정보를 업데이트합니다.
   */
  private async updateCacheInfo(info: CacheInfo): Promise<void> {
    try {
      await this.cacheManager.set(
        this.CACHE_KEYS.CACHE_INFO,
        info,
        this.CACHE_TTL.CACHE_INFO,
      );
    } catch (error) {
      this.logger.error('Error updating cache info:', error);
    }
  }

  /**
   * 캐시를 초기화합니다.
   */
  async clearCache(): Promise<void> {
    try {
      await Promise.all([
        this.cacheManager.del(this.CACHE_KEYS.RECENT_NOTICES),
        this.cacheManager.del(this.CACHE_KEYS.NEW_NOTICES_SET),
        this.cacheManager.del(this.CACHE_KEYS.CACHE_INFO),
      ]);

      // 초기화된 상태의 캐시 정보 저장
      await this.updateCacheInfo({
        size: 0,
        lastUpdated: null,
        maxSize: this.MAX_CACHE_SIZE,
        isInitialized: false,
      });

      LoggerUtils.logDev(this.logger, 'Redis cache cleared');
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
      // 간단한 테스트 키로 연결 상태 확인
      await this.cacheManager.set('health_check', 'ok', 1000);
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
      // 연결 테스트 및 응답 시간 측정
      const testKey = `health_check_${Date.now()}`;
      await this.cacheManager.set(testKey, 'performance_test', 1000);
      const retrievedValue = await this.cacheManager.get(testKey);
      await this.cacheManager.del(testKey);

      const responseTime = Date.now() - startTime;
      const cacheInfo = await this.getCacheInfo();

      if (retrievedValue === 'performance_test') {
        LoggerUtils.logDev(
          this.logger,
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
