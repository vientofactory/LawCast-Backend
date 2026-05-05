import { Injectable, Logger } from '@nestjs/common';
import { type ISearchQuery } from 'pal-crawl';
import { type AISummaryStatus } from '../types/cache.types';
import { CrawlingCoreService } from './crawling-core.service';
import { NoticeArchiveService } from './notice-archive.service';

export interface SearchNoticesQuery {
  keyword: string;
  page: number;
  limit: number;
  includeDone?: boolean;
}

export interface SearchNoticesItem {
  num: number;
  subject: string;
  proposerCategory: string;
  committee: string;
  link: string;
  contentId: string | null;
  isDone: boolean;
  isArchived: boolean;
  aiSummary: string | null;
  aiSummaryStatus: AISummaryStatus;
  attachments: { pdfFile: string; hwpFile: string };
  archiveStartedAt: Date | null;
  lastUpdatedAt: Date | null;
}

export interface SearchNoticesResult {
  items: SearchNoticesItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  keyword: string;
  source: 'archive' | 'crawler' | 'mixed';
}

@Injectable()
export class NoticeSearchService {
  private readonly logger = new Logger(NoticeSearchService.name);
  // Deduplicates concurrent requests for the same search parameters
  private readonly inFlight = new Map<string, Promise<SearchNoticesResult>>();

  constructor(
    private readonly noticeArchiveService: NoticeArchiveService,
    private readonly crawlingCoreService: CrawlingCoreService,
  ) {}

  async searchNotices(query: SearchNoticesQuery): Promise<SearchNoticesResult> {
    const key = `${query.keyword.trim()}|${query.page}|${query.limit}|${query.includeDone ?? true}`;

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.executeSearch(query).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  private async executeSearch(
    query: SearchNoticesQuery,
  ): Promise<SearchNoticesResult> {
    const { page, limit, includeDone = true } = query;
    const keyword = query.keyword.trim();
    const crawlerQuery: ISearchQuery = { billName: keyword, pageUnit: 100 };

    const [dbResult, crawlerActiveResult, crawlerDoneResult] =
      await Promise.allSettled([
        this.noticeArchiveService.getArchiveNotices({
          page: 1,
          limit: 200,
          search: keyword,
          sortOrder: 'desc',
        }),
        this.crawlingCoreService.search(crawlerQuery),
        includeDone
          ? this.crawlingCoreService.searchDone(crawlerQuery)
          : Promise.resolve({
              items: [],
              total: 0,
              totalPages: 0,
              currentPage: 1,
            }),
      ]);

    const archivedNums = new Set<number>();
    const items: SearchNoticesItem[] = [];

    if (dbResult.status === 'fulfilled') {
      for (const item of dbResult.value.items) {
        archivedNums.add(item.num);
        items.push({
          num: item.num,
          subject: item.subject,
          proposerCategory: item.proposerCategory,
          committee: item.committee,
          link: item.link,
          contentId: item.contentId,
          isDone: item.isDone,
          isArchived: true,
          aiSummary: item.aiSummary,
          aiSummaryStatus: item.aiSummaryStatus,
          attachments: item.attachments,
          archiveStartedAt: item.archiveStartedAt,
          lastUpdatedAt: item.lastUpdatedAt,
        });
      }
    } else {
      this.logger.warn(
        'DB search failed:',
        (crawlerActiveResult as PromiseRejectedResult).reason,
      );
    }

    if (crawlerActiveResult.status === 'fulfilled') {
      for (const crawlerItem of crawlerActiveResult.value.items) {
        if (!archivedNums.has(crawlerItem.num)) {
          items.push({
            num: crawlerItem.num,
            subject: crawlerItem.subject,
            proposerCategory: crawlerItem.proposerCategory,
            committee: crawlerItem.committee,
            link: crawlerItem.link,
            contentId: crawlerItem.contentId,
            isDone: false,
            isArchived: false,
            aiSummary: null,
            aiSummaryStatus: 'not_requested' as AISummaryStatus,
            attachments: {
              pdfFile: crawlerItem.attachments.pdfFile ?? '',
              hwpFile: crawlerItem.attachments.hwpFile ?? '',
            },
            archiveStartedAt: null,
            lastUpdatedAt: null,
          });
        }
      }
    } else {
      this.logger.warn(
        'Crawler active search failed:',
        crawlerActiveResult.reason,
      );
    }

    if (includeDone && crawlerDoneResult.status === 'fulfilled') {
      for (const crawlerItem of crawlerDoneResult.value.items) {
        if (!archivedNums.has(crawlerItem.num)) {
          items.push({
            num: crawlerItem.num,
            subject: crawlerItem.subject,
            proposerCategory: crawlerItem.proposerCategory,
            committee: crawlerItem.committee,
            link: crawlerItem.link,
            contentId: crawlerItem.contentId,
            isDone: true,
            isArchived: false,
            aiSummary: null,
            aiSummaryStatus: 'not_requested' as AISummaryStatus,
            attachments: {
              pdfFile: crawlerItem.attachments.pdfFile ?? '',
              hwpFile: crawlerItem.attachments.hwpFile ?? '',
            },
            archiveStartedAt: null,
            lastUpdatedAt: null,
          });
        }
      }
    } else if (includeDone && crawlerDoneResult.status === 'rejected') {
      this.logger.warn('Crawler done search failed:', crawlerDoneResult.reason);
    }

    items.sort((a, b) => b.num - a.num);

    const total = items.length;
    const startIdx = (page - 1) * limit;
    const pageItems = items.slice(startIdx, startIdx + limit);

    const hasArchived = items.some((i) => i.isArchived);
    const hasCrawler = items.some((i) => !i.isArchived);
    const source: 'archive' | 'crawler' | 'mixed' =
      hasArchived && hasCrawler ? 'mixed' : hasCrawler ? 'crawler' : 'archive';

    return {
      items: pageItems,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      keyword,
      source,
    };
  }
}
