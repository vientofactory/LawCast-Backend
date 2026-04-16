import { Injectable } from '@nestjs/common';
import { APP_CONSTANTS } from '../config/app.config';
import { type CachedNotice } from '../types/cache.types';
import { CrawlingService } from './crawling.service';
import { NoticeArchiveService } from './notice-archive.service';

interface ArchivedNoticesQuery {
  page: number;
  limit: number;
  search?: string;
}

@Injectable()
export class NoticesQueryService {
  constructor(
    private readonly crawlingService: CrawlingService,
    private readonly noticeArchiveService: NoticeArchiveService,
  ) {}

  async getArchivedNotices({ page, limit, search }: ArchivedNoticesQuery) {
    const safePage = Math.max(APP_CONSTANTS.API.PAGINATION.MIN_PAGE, page);
    const safeLimit = Math.min(
      APP_CONSTANTS.API.PAGINATION.MAX_LIMIT,
      Math.max(APP_CONSTANTS.API.PAGINATION.MIN_LIMIT, limit),
    );
    const normalizedSearch = (search || '').trim();

    const cachedNotices = await this.crawlingService.getRecentNotices(
      APP_CONSTANTS.CACHE.MAX_SIZE,
    );

    const filteredCached = normalizedSearch
      ? cachedNotices.filter((notice) =>
          this.matchesSearchKeyword(notice, normalizedSearch),
        )
      : cachedNotices;

    const cachedNoticeMap = new Map(
      filteredCached.map((notice) => [notice.num, notice]),
    );

    const existingArchivedNums =
      await this.noticeArchiveService.getExistingNoticeNumSet(
        filteredCached.map((notice) => notice.num),
      );

    const cacheOnlyItems = filteredCached
      .filter((notice) => !existingArchivedNums.has(notice.num))
      .map((notice) => this.mapCachedNoticeToListItem(notice));

    const cacheOnlyCount = cacheOnlyItems.length;
    const globalStart = (safePage - 1) * safeLimit;
    const globalEnd = globalStart + safeLimit;

    const cacheSliceStart = Math.min(globalStart, cacheOnlyCount);
    const cacheSliceEnd = Math.min(globalEnd, cacheOnlyCount);
    const cacheSlice = cacheOnlyItems.slice(cacheSliceStart, cacheSliceEnd);

    const remainingTake = Math.max(0, safeLimit - cacheSlice.length);
    const archiveSkip = Math.max(0, globalStart - cacheOnlyCount);

    const archivePageResult =
      await this.noticeArchiveService.getArchiveNoticesByOffset({
        skip: archiveSkip,
        take: remainingTake,
        search: normalizedSearch,
      });

    const totalArchiveCount = normalizedSearch
      ? await this.noticeArchiveService.getArchiveCount()
      : archivePageResult.total;

    const archiveItems = archivePageResult.items.map((item) => {
      const cached = cachedNoticeMap.get(item.num);

      if (!cached) {
        return item;
      }

      return {
        ...item,
        aiSummary: cached.aiSummary ?? item.aiSummary,
        aiSummaryStatus:
          cached.aiSummaryStatus ?? item.aiSummaryStatus ?? 'not_requested',
      };
    });

    const items = [...cacheSlice, ...archiveItems];
    const total = cacheOnlyCount + archivePageResult.total;

    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      search: normalizedSearch,
      stats: {
        cacheCount: cachedNotices.length,
        matchedCacheCount: filteredCached.length,
        archiveCount: archivePageResult.total,
        totalArchiveCount,
        mergedCount: total,
      },
    };
  }

  private mapCachedNoticeToListItem(notice: CachedNotice) {
    return {
      num: notice.num,
      subject: notice.subject,
      proposerCategory: notice.proposerCategory,
      committee: notice.committee,
      link: notice.link,
      contentId: notice.contentId ?? null,
      aiSummary: notice.aiSummary ?? null,
      aiSummaryStatus: notice.aiSummaryStatus ?? 'not_requested',
      attachments: {
        pdfFile: notice.attachments?.pdfFile ?? '',
        hwpFile: notice.attachments?.hwpFile ?? '',
      },
      archiveStartedAt: null,
      lastUpdatedAt: null,
    };
  }

  private matchesSearchKeyword(notice: CachedNotice, search: string): boolean {
    const keyword = search.toLowerCase();
    const target = [
      notice.subject,
      notice.proposerCategory,
      notice.committee,
      notice.aiSummary || '',
    ]
      .join(' ')
      .toLowerCase();

    return target.includes(keyword);
  }
}
