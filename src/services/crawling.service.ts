import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_CONSTANTS } from '../config/app.config';
import { type CacheInfo, type CachedNotice } from '../types/cache.types';
import { NoticeArchiveService } from './notice-archive.service';
import { CacheService } from './cache.service';
import { CrawlingSchedulerService } from './crawling-scheduler.service';
import { HealthCheckService } from './health-check.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { CrawlingCoreService } from './crawling-core.service';

@Injectable()
export class CrawlingService {
  private readonly logger = new Logger(CrawlingService.name);

  constructor(
    private cacheService: CacheService,
    private noticeArchiveService: NoticeArchiveService,
    private crawlingSchedulerService: CrawlingSchedulerService,
    private healthCheckService: HealthCheckService,
    private archiveOrchestratorService: ArchiveOrchestratorService,
    private crawlingCoreService: CrawlingCoreService,
  ) {}

  /**
   * 크론 작업을 처리합니다.
   */
  async handleCron() {
    await this.crawlingSchedulerService.handleCron();
  }

  /**
   * 캐시된 최근 입법예고를 반환
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

  async getApiHealthPayload(params: { nodeEnv?: string }) {
    return await this.healthCheckService.getApiHealthPayload(params);
  }

  async getRedisStatusForApi(params: { nodeEnv?: string }) {
    return await this.healthCheckService.getRedisStatusForApi(params);
  }

  async getOllamaMetrics(options: { forceHealthCheck?: boolean } = {}) {
    return await this.healthCheckService.getOllamaMetrics(options);
  }
}
