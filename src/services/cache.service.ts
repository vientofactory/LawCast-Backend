import { Injectable, Logger, Inject, OnModuleDestroy } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { type ITableData } from 'pal-crawl';
import { APP_CONSTANTS } from '../config/app.config';
import { LoggerUtils } from '../utils/logger.utils';
import { type CacheInfo, type CachedNotice } from '../types/cache.types';

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly MAX_CACHE_SIZE = APP_CONSTANTS.CACHE.MAX_SIZE;
  private readonly CACHE_KEYS = APP_CONSTANTS.CACHE.KEYS;

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

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
   * Returns the cached list of recent legislative notices.
   * @param limit The maximum number of notices to return.
   * @returns A promise that resolves to an array of cached notices.
   */
  async getRecentNotices(
    limit: number = APP_CONSTANTS.CACHE.DEFAULT_LIMIT,
  ): Promise<CachedNotice[]> {
    try {
      const cachedNotices = await this.cacheManager.get<CachedNotice[]>(
        this.CACHE_KEYS.RECENT_NOTICES,
      );

      if (!cachedNotices || cachedNotices.length === 0) {
        LoggerUtils.logDev(CacheService.name, 'No cached notices found');
        return [];
      }

      const actualLimit = Math.min(limit, this.MAX_CACHE_SIZE);
      return cachedNotices
        .slice(0, actualLimit)
        .map((notice) => this.sanitizeNotice(notice));
    } catch (error) {
      this.logger.error('Error getting cached notices:', error);
      return [];
    }
  }

  /**
   * Initializes or updates the cache.
   * Merges existing data with new data to maintain the most recent order.
   * @param notices An array of notices to be cached.
   */
  async updateCache(notices: CachedNotice[]): Promise<void> {
    try {
      const sortedNotices = notices
        .map((notice) => this.sanitizeNotice(notice))
        .sort((a, b) => b.num - a.num);

      const existingNotices =
        (await this.cacheManager.get<CachedNotice[]>(
          this.CACHE_KEYS.RECENT_NOTICES,
        )) || [];

      const normalizedExistingNotices = existingNotices.map((notice) =>
        this.sanitizeNotice(notice),
      );

      const mergedNotices = [...sortedNotices, ...normalizedExistingNotices];

      const dedupedNotices = new Map<number, CachedNotice>();
      for (const notice of mergedNotices) {
        const existingNotice = dedupedNotices.get(notice.num);

        if (!existingNotice) {
          dedupedNotices.set(notice.num, notice);
          continue;
        }

        if (!existingNotice.aiSummary && notice.aiSummary) {
          dedupedNotices.set(notice.num, {
            ...existingNotice,
            aiSummary: notice.aiSummary,
            aiSummaryStatus: notice.aiSummaryStatus ?? 'ready',
          });
          continue;
        }

        if (
          existingNotice.aiSummaryStatus !== 'ready' &&
          notice.aiSummaryStatus === 'ready'
        ) {
          dedupedNotices.set(notice.num, {
            ...existingNotice,
            aiSummaryStatus: 'ready',
            aiSummary: notice.aiSummary ?? existingNotice.aiSummary ?? null,
          });
        }
      }

      const uniqueNotices = Array.from(dedupedNotices.values())
        .sort((a, b) => b.num - a.num)
        .slice(0, this.MAX_CACHE_SIZE);

      await Promise.all([
        this.cacheManager.set(this.CACHE_KEYS.RECENT_NOTICES, uniqueNotices, 0),
        this.cacheManager.set(this.CACHE_KEYS.LAST_UPDATED, new Date(), 0),
      ]);

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
   * Finds new legislative notices that are not yet cached.
   * @param crawledData An array of crawled legislative notices.
   * @returns A promise that resolves to an array of new notices.
   */
  async findNewNotices(crawledData: ITableData[]): Promise<ITableData[]> {
    try {
      const existingNotices =
        (await this.cacheManager.get<CachedNotice[]>(
          this.CACHE_KEYS.RECENT_NOTICES,
        )) || [];

      const normalizedExistingNotices = existingNotices.map((notice) =>
        this.sanitizeNotice(notice),
      );

      if (normalizedExistingNotices.length === 0) {
        LoggerUtils.logDev(
          CacheService.name,
          'Cache is empty, all crawled data considered new',
        );
        return crawledData;
      }

      const existingNums = new Set(
        normalizedExistingNotices.map((notice) => notice.num),
      );

      const newNotices = crawledData.filter(
        (item) => !existingNums.has(item.num),
      );

      LoggerUtils.logDev(
        CacheService.name,
        `Found ${newNotices.length} new notices out of ${crawledData.length} crawled (cache has ${normalizedExistingNotices.length})`,
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
   * Returns cache information.
   * @returns A promise that resolves to an object containing cache information.
   */
  async getCacheInfo(): Promise<CacheInfo> {
    try {
      const cachedNotices =
        (await this.cacheManager.get<CachedNotice[]>(
          this.CACHE_KEYS.RECENT_NOTICES,
        )) || [];
      const lastUpdated =
        (await this.cacheManager.get<Date | string>(
          this.CACHE_KEYS.LAST_UPDATED,
        )) || null;

      return {
        size: cachedNotices.length,
        lastUpdated: lastUpdated ? new Date(lastUpdated) : null,
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
   * Clears the entire cache.
   */
  async clearCache(): Promise<void> {
    try {
      await Promise.all([
        this.cacheManager.del(this.CACHE_KEYS.RECENT_NOTICES),
        this.cacheManager.del(this.CACHE_KEYS.LAST_UPDATED),
      ]);
      LoggerUtils.logDev(CacheService.name, 'Redis cache cleared');
    } catch (error) {
      this.logger.error('Error clearing Redis cache:', error);
      throw error;
    }
  }

  /**
   * Checks the Redis connection status.
   * @returns A promise that resolves to a boolean indicating whether Redis is connected.
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
   * Retrieves detailed Redis status and performance information.
   * @returns A promise that resolves to an object containing Redis status, response time, cache information, and any error message.
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
      const message = error instanceof Error ? error.message : String(error);

      return {
        connected: false,
        responseTime: Date.now() - startTime,
        cacheInfo: {
          size: 0,
          lastUpdated: null,
          maxSize: this.MAX_CACHE_SIZE,
          isInitialized: false,
        },
        error: message || 'Unknown Redis error',
      };
    }
  }

  /**
   * Retrieves a numeric value from the cache.
   * @param key The cache key to retrieve.
   * @returns A promise that resolves to the numeric value or null if not found or invalid.
   */
  async getNumber(key: string): Promise<number | null> {
    try {
      const value = await this.cacheManager.get<number>(key);
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return null;
      }
      return value;
    } catch (error) {
      this.logger.warn(`Error reading numeric cache key (${key}):`, error);
      return null;
    }
  }

  /**
   * Sets a numeric value in the cache.
   * @param key The cache key to set.
   * @param value The numeric value to store.
   * @param ttl The time-to-live (TTL) in seconds. Defaults to 0 (no expiration).
   * @returns A promise that resolves when the value is set.
   */
  async setNumber(key: string, value: number, ttl = 0): Promise<void> {
    try {
      await this.cacheManager.set(key, value, ttl);
    } catch (error) {
      this.logger.warn(`Error writing numeric cache key (${key}):`, error);
    }
  }

  /**
   * Sanitizes a cached notice by removing unnecessary properties.
   * @param notice The cached notice to sanitize.
   * @returns The sanitized cached notice.
   */
  private sanitizeNotice(notice: CachedNotice): CachedNotice {
    const { numComments: _numComments, ...rest } = notice as CachedNotice & {
      numComments?: number;
    };
    return rest;
  }
}
