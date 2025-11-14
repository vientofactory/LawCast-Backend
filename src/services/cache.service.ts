import { Injectable, Logger } from '@nestjs/common';
import { type ITableData } from 'pal-crawl';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private recentNoticesCache: ITableData[] = [];
  private lastUpdated: Date | null = null;
  private isInitialized = false;
  private readonly MAX_CACHE_SIZE = 50; // 최대 50개의 최근 입법예고 캐시

  /**
   * 캐시된 최근 입법예고 목록을 반환합니다.
   */
  getRecentNotices(limit: number = 10): ITableData[] {
    return this.recentNoticesCache.slice(
      0,
      Math.min(limit, this.MAX_CACHE_SIZE),
    );
  }

  /**
   * 초기화용 캐시 업데이트 (알림 없이)
   */
  initializeCache(allNotices: ITableData[]): void {
    // 최신 순으로 정렬 (num이 높을수록 최신)
    const sortedNotices = [...allNotices].sort((a, b) => b.num - a.num);

    // 최대 캐시 크기만큼만 저장
    this.recentNoticesCache = sortedNotices.slice(0, this.MAX_CACHE_SIZE);
    this.lastUpdated = new Date();
    this.isInitialized = true;

    this.logger.log(
      `Cache initialized with ${this.recentNoticesCache.length} notices`,
    );
  }

  /**
   * 새로운 데이터로 캐시를 업데이트합니다.
   */
  updateCache(allNotices: ITableData[]): void {
    // 최신 순으로 정렬 (num이 높을수록 최신)
    const sortedNotices = [...allNotices].sort((a, b) => b.num - a.num);

    // 최대 캐시 크기만큼만 저장
    this.recentNoticesCache = sortedNotices.slice(0, this.MAX_CACHE_SIZE);
    this.lastUpdated = new Date();

    this.logger.log(
      `Cache updated with ${this.recentNoticesCache.length} notices`,
    );
  }

  /**
   * 새로운 입법예고들을 찾습니다.
   */
  findNewNotices(crawledData: ITableData[]): ITableData[] {
    if (!this.isInitialized) {
      // 초기화되지 않은 상태에서는 새로운 항목이 없다고 반환
      return [];
    }

    const existingNums = new Set(
      this.recentNoticesCache.map((notice) => notice.num),
    );
    return crawledData.filter((item) => !existingNums.has(item.num));
  }

  /**
   * 캐시 정보를 반환합니다.
   */
  getCacheInfo() {
    return {
      size: this.recentNoticesCache.length,
      lastUpdated: this.lastUpdated,
      maxSize: this.MAX_CACHE_SIZE,
      isInitialized: this.isInitialized,
    };
  }

  /**
   * 캐시를 초기화합니다.
   */
  clearCache(): void {
    this.recentNoticesCache = [];
    this.lastUpdated = null;
    this.isInitialized = false;
    this.logger.log('Cache cleared');
  }
}
