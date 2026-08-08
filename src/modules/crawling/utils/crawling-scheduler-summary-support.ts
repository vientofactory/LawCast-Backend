import { AISummaryStatus, type CachedNotice } from '../../../types/cache.types';
import { CacheService } from '../../cache/cache.service';
import {
  NoticeArchiveService,
  type ArchiveSummaryState,
} from '../../notice/notice-archive.service';
import { SummaryGenerationService } from '../summary-generation.service';
import { DiscordBridgeService } from '../../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { logAndBridge } from '../../../utils/bridge-log.utils';

interface SummarySupportLogger {
  log(message: string): void;
  warn(message: string): void;
}

interface SummarySupportOptions {
  cacheService: CacheService;
  noticeArchiveService: NoticeArchiveService;
  summaryGenerationService: SummaryGenerationService;
  logger: SummarySupportLogger;
  discordBridge?: DiscordBridgeService;
}

export class CrawlingSchedulerSummarySupport {
  constructor(private readonly options: SummarySupportOptions) {}

  private async persistSummaryStateBatch(
    notices: CachedNotice[],
  ): Promise<{ persistedNoticeNums: Set<number>; failedCount: number }> {
    if (notices.length === 0) {
      return { persistedNoticeNums: new Set<number>(), failedCount: 0 };
    }

    const svcCompat = this.options.noticeArchiveService as {
      updateSummaryStatesByNoticeNums?: (
        updates: Array<{
          noticeNum: number;
          summary: string | null;
          status: AISummaryStatus;
        }>,
      ) => Promise<Set<number>>;
      updateSummaryStateByNoticeNum: (
        noticeNum: number,
        summary: string | null,
        status: AISummaryStatus,
      ) => Promise<void>;
    };

    if (svcCompat.updateSummaryStatesByNoticeNums) {
      try {
        const persistedNoticeNums =
          await svcCompat.updateSummaryStatesByNoticeNums(
            notices.map((notice) => ({
              noticeNum: notice.num,
              summary: notice.aiSummary ?? null,
              status: notice.aiSummaryStatus ?? 'not_requested',
            })),
          );

        return {
          persistedNoticeNums,
          failedCount: notices.length - persistedNoticeNums.size,
        };
      } catch (error) {
        this.options.logger.warn(
          `Bulk summary state persistence failed: ${(error as Error).message}; retrying single-row writes`,
        );
      }
    }

    const persistResults = await Promise.allSettled(
      notices.map((notice) =>
        svcCompat.updateSummaryStateByNoticeNum(
          notice.num,
          notice.aiSummary ?? null,
          notice.aiSummaryStatus ?? 'not_requested',
        ),
      ),
    );

    const persistedNoticeNums = new Set<number>();
    for (let index = 0; index < persistResults.length; index += 1) {
      if (persistResults[index].status === 'fulfilled') {
        persistedNoticeNums.add(notices[index].num);
      }
    }

    return {
      persistedNoticeNums,
      failedCount: notices.length - persistedNoticeNums.size,
    };
  }

  buildNoticeMap(notices: CachedNotice[]): Map<number, CachedNotice> {
    return new Map(notices.map((notice) => [notice.num, notice]));
  }

  resolveSummaryStatus(summary?: string | null): 'ready' | 'unavailable' {
    return summary?.trim() ? 'ready' : 'unavailable';
  }

  async retryUnavailableSummariesInBackground(
    notices: CachedNotice[],
    existingNoticeMap: Map<number, CachedNotice>,
  ): Promise<void> {
    const retried = await this.retryUnavailableSummariesFromPreviousCycle(
      notices,
      existingNoticeMap,
    );
    await this.options.cacheService.updateCache(retried);
  }

  async persistRetriedArchiveSummaryStates(
    noticesWithSummary: CachedNotice[],
    archiveSummaryStates: Map<number, ArchiveSummaryState>,
  ): Promise<void> {
    const changedRetriedNotices = noticesWithSummary.filter((notice) => {
      const previousState = archiveSummaryStates.get(notice.num);

      if (!previousState) {
        return false;
      }

      const wasPending =
        previousState.aiSummaryStatus === 'not_requested' ||
        previousState.aiSummaryStatus === 'unavailable';

      if (!wasPending) {
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

    const { failedCount: persistFailed } = await this.persistSummaryStateBatch(
      changedRetriedNotices,
    );
    if (persistFailed > 0) {
      this.options.logger.warn(
        `Failed to persist ${persistFailed}/${changedRetriedNotices.length} retried summary states`,
      );
    }

    this.options.logger.log(
      `Persisted retried summary state for ${changedRetriedNotices.length - persistFailed} archived notices`,
    );
  }

  async retryUnavailableSummariesFromPreviousCycle(
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

    this.options.logger.log(
      `Retrying unavailable summaries for ${retryCandidates.length} notices`,
    );
    logAndBridge({
      logger: this.options.logger,
      method: 'log',
      message: `Retrying unavailable summaries for ${retryCandidates.length} notices`,
      context: 'CrawlingSchedulerService',
      discordBridge: this.options.discordBridge,
      bridgeLevel: BridgeLogLevel.WARN,
      bridgeMessage: `Retrying unavailable summaries for ${retryCandidates.length} notices`,
    });

    const retryResults = await Promise.all(
      retryCandidates.map(async (notice, index) => {
        const summaryResult =
          await this.options.summaryGenerationService.generateSummaryForNotice(
            notice,
            {
              logOllamaActivity: true,
              phase: 'cron-retry',
              index,
              total: retryCandidates.length,
            },
          );

        return {
          num: notice.num,
          aiSummary: summaryResult.aiSummary,
          aiSummaryStatus: summaryResult.aiSummaryStatus,
        };
      }),
    );

    const retryResultMap = new Map(
      retryResults.map((result) => [result.num, result]),
    );

    const recoveredCount = retryResults.filter(
      (result) => result.aiSummaryStatus === 'ready',
    ).length;
    logAndBridge({
      method: 'debug',
      message: `summary retry recovered=${recoveredCount}/${retryCandidates.length}`,
      context: 'CrawlingSchedulerService',
      discordBridge: this.options.discordBridge,
      bridgeLevel: BridgeLogLevel.DEBUG,
      bridgeMessage: `Summary retry: **${recoveredCount}/${retryCandidates.length}** recovered`,
      metadata: {
        candidates: retryCandidates.length,
        recovered: recoveredCount,
        stillUnavailable: retryCandidates.length - recoveredCount,
      },
    });

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

    const { persistedNoticeNums, failedCount: persistFailed } =
      await this.persistSummaryStateBatch(changedRetriedNotices);
    if (persistFailed > 0) {
      this.options.logger.warn(
        `Failed to persist ${persistFailed}/${changedRetriedNotices.length} cron retried summary states`,
      );
    }

    this.options.logger.log(
      `Persisted cron retried summary state for ${persistedNoticeNums.size} notices`,
    );

    return mergedNotices.filter((notice) =>
      persistedNoticeNums.has(notice.num),
    );
  }
}
