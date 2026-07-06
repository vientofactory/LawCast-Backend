import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_CONSTANTS } from '../../config/app.config';
import {
  type CacheInfo,
  type CachedNotice,
  type QuickKeywordSuggestionsCache,
  type QuickKeywordSuggestionsResult,
} from '../../types/cache.types';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { CacheService } from '../cache/cache.service';
import { CrawlingSchedulerService } from './crawling-scheduler.service';
import { HealthCheckService } from '../health/health-check.service';
import { CrawlingCoreService } from './crawling-core.service';
import { LoggerUtils } from '../../utils/logger.utils';

@Injectable()
export class CrawlingService {
  private readonly logger = LoggerUtils.getContextLogger(CrawlingService.name);
  private readonly quickKeywordRefreshIntervalMs =
    APP_CONSTANTS.CACHE.TTL.QUICK_KEYWORDS;
  private readonly quickKeywordSourceLimit = 300;
  private readonly quickKeywordDefaultLimit = 8;
  private readonly quickKeywordStopwords = new Set([
    '가',
    '개정',
    '개정안',
    '국회',
    '관한',
    '관련',
    '규칙안',
    '대한',
    '등',
    '법률',
    '법률안',
    '법안',
    '발의',
    '및',
    '시행규칙',
    '시행규칙안',
    '시행령',
    '시행령안',
    '에',
    '의',
    '의안',
    '의안번호',
    '의원',
    '일부개정',
    '일부개정법률안',
    '일부개정안',
    '일부를',
    '일부법률안',
    '일부사항',
    '전부개정',
    '전부개정법률안',
    '전부개정안',
    '제',
    '제정',
    '제정법률안',
    '조례안',
    '중',
    '타법개정',
    '통해',
    '특별법',
    '특별법안',
    '기본법',
    '폐지',
    '폐지법률안',
    '지원',
    '위한',
    '공정화',
    '하기',
    '하는',
    '한',
  ]);
  private readonly quickKeywordParticleSuffixes = [
    '으로',
    '에서',
    '에게',
    '까지',
    '부터',
    '처럼',
    '보다',
    '마다',
    '에는',
    '에서',
    '의',
    '에',
    '은',
    '는',
    '이',
    '가',
    '을',
    '를',
    '와',
    '과',
    '도',
    '로',
  ] as const;

  constructor(
    private cacheService: CacheService,
    private noticeArchiveService: NoticeArchiveService,
    private crawlingSchedulerService: CrawlingSchedulerService,
    private healthCheckService: HealthCheckService,
    private crawlingCoreService: CrawlingCoreService,
  ) {}

  /**
   * Handles the cron job.
   */
  async handleCron() {
    await this.crawlingSchedulerService.handleCron();
  }

  /**
   * Handles the pending-bills cron: detects newly proposed bills from
   * NsmLmSts (\uad6d\ubbfc\ucc38\uc5ec\uc785\ubc95\uc13c\ud130) before they appear in \uc785\ubc95\uc608\uace0.
   */
  async handlePendingCron() {
    await this.crawlingSchedulerService.handlePendingCron();
  }

  /**
   * True when crawling scheduler is in fast-path processing or running
   * background follow-up tasks.
   */
  isSchedulerBusy(options?: { includeBackground?: boolean }): boolean {
    return this.crawlingSchedulerService.isBusy(options);
  }

  async getQuickKeywordSuggestions(
    limit: number = this.quickKeywordDefaultLimit,
  ): Promise<QuickKeywordSuggestionsResult> {
    const safeLimit = this.normalizeQuickKeywordLimit(limit);
    const cached = await this.cacheService.getQuickKeywordSuggestions();

    if (cached && this.isQuickKeywordCacheFresh(cached)) {
      return this.limitQuickKeywordSuggestions(cached, safeLimit);
    }

    try {
      const refreshed = await this.refreshQuickKeywordSuggestions(safeLimit);
      return this.limitQuickKeywordSuggestions(refreshed, safeLimit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to refresh quick keywords: ${message}`);

      if (cached) {
        return this.limitQuickKeywordSuggestions(cached, safeLimit);
      }

      return {
        items: [],
        updatedAt: null,
        sourceNoticeCount: 0,
        refreshIntervalMs: this.quickKeywordRefreshIntervalMs,
      };
    }
  }

  async refreshQuickKeywordSuggestions(
    limit: number = this.quickKeywordDefaultLimit,
  ): Promise<QuickKeywordSuggestionsResult> {
    const safeLimit = this.normalizeQuickKeywordLimit(limit);
    const notices = await this.cacheService.getRecentNotices(
      this.quickKeywordSourceLimit,
    );
    const cachePayload = this.buildQuickKeywordSuggestionsCache(notices);

    await this.cacheService.setQuickKeywordSuggestions(cachePayload);

    return this.limitQuickKeywordSuggestions(cachePayload, safeLimit);
  }

  /** Snapshot of scheduler lock/background-task execution state. */
  getSchedulerExecutionState(): {
    isInitialized: boolean;
    isProcessing: boolean;
    activeBackgroundTaskCount: number;
    activeBackgroundTasks: string[];
  } {
    return this.crawlingSchedulerService.getExecutionState();
  }

  /**
   * Retrieves the cached recent notices.
   * @param limit The maximum number of notices to retrieve. Defaults to the configured cache limit.
   * @returns A promise that resolves to an array of cached notices.
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

  /**
   * Retrieves the detailed content of a specific notice by its notice number.
   * @param noticeNum The unique identifier for the notice.
   * @returns A promise that resolves to the detailed content of the notice.
   */
  async getNoticeDetail(noticeNum: number): Promise<{
    notice: CachedNotice;
    originalContent: {
      contentId: string;
      title: string;
      proposalReason: string;
      billNumber: string | null;
      proposer: string | null;
      proposalDate: string | null;
      committee: string | null;
      referralDate: string | null;
      noticePeriod: string | null;
      proposalSession: string | null;
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
      const content = await this.crawlingCoreService.getContent(
        notice.contentId,
      );
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
          billNumber: content?.billNumber?.trim() || null,
          proposer: content?.proposer?.trim() || null,
          proposalDate: content?.proposalDate?.trim() || null,
          committee: content?.committee?.trim() || null,
          referralDate: content?.referralDate?.trim() || null,
          noticePeriod: content?.noticePeriod?.trim() || null,
          proposalSession: content?.proposalSession?.trim() || null,
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

  private isQuickKeywordCacheFresh(
    cached: QuickKeywordSuggestionsCache,
  ): boolean {
    const updatedAt = new Date(cached.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      return false;
    }

    if (
      cached.items.length > 0 &&
      cached.items.some(
        (item) => !this.isAcceptableQuickKeywordToken(item.keyword),
      )
    ) {
      return false;
    }

    return (
      Date.now() - updatedAt.getTime() < this.quickKeywordRefreshIntervalMs
    );
  }

  private limitQuickKeywordSuggestions(
    payload: QuickKeywordSuggestionsCache,
    limit: number,
  ): QuickKeywordSuggestionsResult {
    return {
      items: payload.items.slice(0, limit),
      updatedAt: payload.updatedAt,
      sourceNoticeCount: payload.sourceNoticeCount,
      refreshIntervalMs: this.quickKeywordRefreshIntervalMs,
    };
  }

  private normalizeQuickKeywordLimit(limit: number): number {
    return Math.max(
      1,
      Math.min(20, Math.trunc(limit) || this.quickKeywordDefaultLimit),
    );
  }

  private buildQuickKeywordSuggestionsCache(
    notices: CachedNotice[],
  ): QuickKeywordSuggestionsCache {
    const ranked = new Map<
      string,
      { keyword: string; score: number; matchCount: number }
    >();

    const sourceNotices = notices.slice(0, this.quickKeywordSourceLimit);
    const total = sourceNotices.length;

    sourceNotices.forEach((notice, index) => {
      const recencyWeight = 1 + (total - index) / Math.max(1, total);
      const tokens = this.extractKeywordTokens(notice.subject);
      const uniqueTokens = new Set(tokens);

      uniqueTokens.forEach((token) => {
        const existing = ranked.get(token);
        if (existing) {
          existing.score += recencyWeight;
          existing.matchCount += 1;
          return;
        }

        ranked.set(token, {
          keyword: token,
          score: recencyWeight,
          matchCount: 1,
        });
      });
    });

    const items = Array.from(ranked.values())
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        if (right.matchCount !== left.matchCount) {
          return right.matchCount - left.matchCount;
        }

        if (right.keyword.length !== left.keyword.length) {
          return right.keyword.length - left.keyword.length;
        }

        return left.keyword.localeCompare(right.keyword, 'ko');
      })
      .slice(0, 20)
      .map((item) => ({
        keyword: item.keyword,
        score: Number(item.score.toFixed(2)),
        matchCount: item.matchCount,
      }));

    return {
      items,
      updatedAt: new Date().toISOString(),
      sourceNoticeCount: sourceNotices.length,
    };
  }

  private extractKeywordTokens(subject: string): string[] {
    const matches = subject.match(/[A-Za-z]+|[0-9]+|[가-힣]+/g) ?? [];

    return matches
      .map((token) => token.trim())
      .map((token) => (/^[A-Za-z]+$/.test(token) ? token.toUpperCase() : token))
      .map((token) => this.normalizeQuickKeywordToken(token))
      .filter((token) => token.length >= 2)
      .filter((token) => !/^\d+$/.test(token))
      .filter((token) => this.isAcceptableQuickKeywordToken(token));
  }

  private normalizeQuickKeywordToken(token: string): string {
    if (!/[가-힣]/.test(token)) {
      return token;
    }

    let normalized = token;

    for (const suffix of this.quickKeywordParticleSuffixes) {
      if (normalized.length <= suffix.length + 1) {
        continue;
      }

      if (normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length);
        break;
      }
    }

    return normalized;
  }

  private isAcceptableQuickKeywordToken(token: string): boolean {
    if (!token || this.quickKeywordStopwords.has(token)) {
      return false;
    }

    if (token.endsWith('위원회') || token.endsWith('특별위원회')) {
      return false;
    }

    if (token.endsWith('의원') || token.includes('의원')) {
      return false;
    }

    if (/^[가-힣]{1,2}$/.test(token)) {
      return false;
    }

    if (
      /(등|사항|체계|정비|강화|확대|촉진|지원|관리|운영|활성화|공정화)$/.test(
        token,
      )
    ) {
      return false;
    }

    return true;
  }

  /**
   * Retrieves the cache information.
   * @returns A promise that resolves to the cache information.
   */
  async getCacheInfo(): Promise<CacheInfo> {
    return await this.cacheService.getCacheInfo();
  }

  /**
   * Checks if Redis is connected.
   * @returns A promise that resolves to a boolean indicating Redis connection status.
   */
  async isRedisConnected(): Promise<boolean> {
    return await this.cacheService.isRedisConnected();
  }

  /**
   * Retrieves the API health payload.
   * @param params Optional parameters for the health check.
   * @returns A promise that resolves to the API health payload.
   */
  async getApiHealthPayload(params: { nodeEnv?: string }) {
    return await this.healthCheckService.getApiHealthPayload(params);
  }

  /**
   * Retrieves the Redis status for the API.
   * @param params Optional parameters for the health check.
   * @returns A promise that resolves to the Redis status for the API.
   */
  async getRedisStatusForApi(params: { nodeEnv?: string }) {
    return await this.healthCheckService.getRedisStatusForApi(params);
  }

  /**
   * Retrieves the Ollama metrics.
   * @param options Optional parameters for the metrics retrieval.
   * @returns A promise that resolves to the Ollama metrics.
   */
  async getOllamaMetrics(options: { forceHealthCheck?: boolean } = {}) {
    return await this.healthCheckService.getOllamaMetrics(options);
  }
}
