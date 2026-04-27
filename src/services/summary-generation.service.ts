import { Injectable, Logger } from '@nestjs/common';
import { type ITableData } from 'pal-crawl';
import { APP_CONSTANTS } from '../config/app.config';
import { type AISummaryStatus, type CachedNotice } from '../types/cache.types';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';
import {
  NoticeArchiveService,
  type ArchiveSummaryState,
} from './notice-archive.service';
import { CrawlingCoreService } from './crawling-core.service';

@Injectable()
export class SummaryGenerationService {
  private readonly logger = new Logger(SummaryGenerationService.name);
  private readonly LOG_PREFIX = {
    OLLAMA: '[Ollama]',
  };

  constructor(
    private ollamaClientService: OllamaClientService,
    private noticeArchiveService: NoticeArchiveService,
    private crawlingCoreService: CrawlingCoreService,
  ) {}

  /**
   * 공지에 요약을 추가합니다.
   */
  async enrichNoticesWithSummary(
    notices: ITableData[],
    existingNotices: Map<number, CachedNotice> = new Map(),
    archiveSummaryStates: Map<number, ArchiveSummaryState> = new Map(),
    options: {
      logOllamaActivity?: boolean;
      phase?: string;
      retryUnavailableArchiveSummary?: boolean;
    } = {},
  ): Promise<CachedNotice[]> {
    const {
      logOllamaActivity = false,
      phase = 'runtime',
      retryUnavailableArchiveSummary = false,
    } = options;

    const summaryConcurrency = APP_CONSTANTS.CRAWLING.SUMMARY_CONCURRENCY;

    return this.mapWithConcurrency(
      notices,
      summaryConcurrency,
      async (notice, index) => {
        const existingNotice = existingNotices.get(notice.num);
        const cachedSummary = existingNotice?.aiSummary;

        if (cachedSummary?.trim()) {
          if (logOllamaActivity) {
            this.logOllama(
              `Skipping notice ${index + 1}/${notices.length} (cache hit: num=${notice.num})`,
              phase,
            );
          }

          return {
            ...notice,
            aiSummary: cachedSummary,
            aiSummaryStatus: 'ready',
          };
        }

        const archivedSummaryState = archiveSummaryStates.get(notice.num);

        if (archivedSummaryState) {
          if (
            retryUnavailableArchiveSummary &&
            archivedSummaryState.aiSummaryStatus === 'unavailable'
          ) {
            if (logOllamaActivity) {
              this.logOllama(
                `Retry summary ${index + 1}/${notices.length} (archive unavailable: num=${notice.num})`,
                phase,
              );
            }

            const retryResult = await this.generateSummaryForNotice(notice, {
              logOllamaActivity,
              phase,
              index,
              total: notices.length,
            });

            return {
              ...notice,
              aiSummary: retryResult.aiSummary,
              aiSummaryStatus: retryResult.aiSummaryStatus,
            };
          }

          if (logOllamaActivity) {
            this.logOllama(
              `Skipping notice ${index + 1}/${notices.length} (archive hit: num=${notice.num})`,
              phase,
            );
          }

          return {
            ...notice,
            aiSummary: archivedSummaryState.aiSummary,
            aiSummaryStatus: archivedSummaryState.aiSummaryStatus,
          };
        }

        const summaryResult = await this.generateSummaryForNotice(notice, {
          logOllamaActivity,
          phase,
          index,
          total: notices.length,
        });

        return {
          ...notice,
          aiSummary: summaryResult.aiSummary,
          aiSummaryStatus: summaryResult.aiSummaryStatus,
        };
      },
    );
  }

  /**
   * 단일 공지에 대한 요약을 생성합니다.
   */
  async generateSummaryForNotice(
    notice: ITableData | CachedNotice,
    options: {
      logOllamaActivity?: boolean;
      phase?: string;
      index?: number;
      total?: number;
    } = {},
  ): Promise<{ aiSummary: string | null; aiSummaryStatus: AISummaryStatus }> {
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

    if (!this.isAiSummaryEnabled()) {
      if (logOllamaActivity) {
        this.logOllama(
          `Skip summary ${progressLabel} (num=${notice.num}) - AI summary disabled`,
          phase,
        );
      }

      return {
        aiSummary: null,
        aiSummaryStatus: 'not_requested',
      };
    }

    if (!notice.contentId) {
      if (logOllamaActivity) {
        this.logOllama(
          `Skip summary ${progressLabel} (num=${notice.num}) - no contentId`,
          phase,
        );
      }

      return {
        aiSummary: null,
        aiSummaryStatus: 'not_supported',
      };
    }

    try {
      const content = await this.crawlingCoreService.getContent(
        notice.contentId,
      );

      if (!content?.proposalReason?.trim()) {
        if (logOllamaActivity) {
          this.logOllama(
            `Skip summary ${progressLabel} (contentId=${notice.contentId}) - empty proposalReason`,
            phase,
          );
        }

        return {
          aiSummary: null,
          aiSummaryStatus: 'not_supported',
        };
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

      return {
        aiSummary: summary,
        aiSummaryStatus: summary ? 'ready' : 'unavailable',
      };
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
      return {
        aiSummary: null,
        aiSummaryStatus: 'unavailable',
      };
    }
  }

  private isAiSummaryEnabled(): boolean {
    return this.ollamaClientService.isEnabled();
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

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const limit = Math.max(1, concurrency);
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= items.length) {
          return;
        }

        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => worker()),
    );

    return results;
  }
}
