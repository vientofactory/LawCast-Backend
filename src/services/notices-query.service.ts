import { Injectable } from '@nestjs/common';
import { APP_CONSTANTS } from '../config/app.config';
import { type CachedNotice } from '../types/cache.types';
import { CrawlingService } from './crawling.service';
import { NoticeArchiveService } from './notice-archive.service';

interface ArchivedNoticesQuery {
  page: number;
  limit: number;
  search?: string;
  startDate?: string;
  endDate?: string;
  sortOrder?: 'asc' | 'desc';
}

@Injectable()
export class NoticesQueryService {
  constructor(
    private readonly crawlingService: CrawlingService,
    private readonly noticeArchiveService: NoticeArchiveService,
  ) {}

  async getArchivedNotices({
    page,
    limit,
    search,
    startDate,
    endDate,
    sortOrder,
  }: ArchivedNoticesQuery) {
    const safePage = Math.max(APP_CONSTANTS.API.PAGINATION.MIN_PAGE, page);
    const safeLimit = Math.min(
      APP_CONSTANTS.API.PAGINATION.MAX_LIMIT,
      Math.max(APP_CONSTANTS.API.PAGINATION.MIN_LIMIT, limit),
    );
    const normalizedSearch = (search || '').trim();
    const normalizedSortOrder = this.normalizeSortOrder(sortOrder);
    const parsedDateRange = this.parseDateRange(startDate, endDate);
    const hasDateFilter =
      !!parsedDateRange.startDate || !!parsedDateRange.endDate;

    const cachedNotices = await this.crawlingService.getRecentNotices(
      APP_CONSTANTS.CACHE.MAX_SIZE,
    );

    const searchedCached = normalizedSearch
      ? cachedNotices.filter((notice) =>
          this.matchesSearchKeyword(notice, normalizedSearch),
        )
      : cachedNotices;

    const cachedNoticeMap = new Map(
      searchedCached.map((notice) => [notice.num, notice]),
    );

    const cacheCandidates: CachedNotice[] = hasDateFilter ? [] : searchedCached;

    const existingArchivedNums =
      await this.noticeArchiveService.getExistingNoticeNumSet(
        cacheCandidates.map((notice) => notice.num),
      );

    const cacheOnlyItems = cacheCandidates
      .filter((notice) => !existingArchivedNums.has(notice.num))
      .map((notice) => this.mapCachedNoticeToListItem(notice))
      .sort((a, b) =>
        this.compareNoticeNums(a.num, b.num, normalizedSortOrder),
      );

    const archiveFilteredTotal =
      await this.noticeArchiveService.getArchiveNoticesByOffset({
        skip: 0,
        take: 0,
        search: normalizedSearch,
        startDate: parsedDateRange.startDate,
        endDate: parsedDateRange.endDate,
        sortOrder: normalizedSortOrder,
      });

    const cacheInsertionEntries = this.buildCacheInsertionEntries({
      cacheOnlyItems,
      sortOrder: normalizedSortOrder,
      archiveTotal: archiveFilteredTotal.total,
    });

    const cacheInsertionMap = new Map(
      cacheInsertionEntries.map((entry) => [entry.position, entry.item]),
    );

    const cacheOnlyCount = cacheOnlyItems.length;
    const globalStart = (safePage - 1) * safeLimit;
    const globalEnd = globalStart + safeLimit;

    const total = cacheOnlyCount + archiveFilteredTotal.total;
    const clampedStart = Math.min(globalStart, total);
    const clampedEnd = Math.min(globalEnd, total);

    const cacheBeforeStart = cacheInsertionEntries.filter(
      (entry) => entry.position < clampedStart,
    ).length;
    const cacheInsidePage = cacheInsertionEntries.filter(
      (entry) => entry.position >= clampedStart && entry.position < clampedEnd,
    ).length;

    const archiveSkip = Math.max(0, clampedStart - cacheBeforeStart);
    const archiveTake = Math.max(
      0,
      clampedEnd - clampedStart - cacheInsidePage,
    );

    const archivePageResult =
      await this.noticeArchiveService.getArchiveNoticesByOffset({
        skip: archiveSkip,
        take: archiveTake,
        search: normalizedSearch,
        startDate: parsedDateRange.startDate,
        endDate: parsedDateRange.endDate,
        sortOrder: normalizedSortOrder,
      });

    const totalArchiveCount =
      normalizedSearch || hasDateFilter
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

    const items = this.mergePageItems({
      startIndex: clampedStart,
      endIndex: clampedEnd,
      cacheInsertionMap,
      archiveItems,
    });

    return {
      items,
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      search: normalizedSearch,
      startDate: parsedDateRange.startDateRaw,
      endDate: parsedDateRange.endDateRaw,
      sortOrder: normalizedSortOrder,
      stats: {
        cacheCount: cachedNotices.length,
        matchedCacheCount: searchedCached.length,
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

  private normalizeSortOrder(sortOrder?: 'asc' | 'desc'): 'asc' | 'desc' {
    return sortOrder === 'asc' ? 'asc' : 'desc';
  }

  private parseDateRange(
    startDate?: string,
    endDate?: string,
  ): {
    startDate?: Date;
    endDate?: Date;
    startDateRaw: string;
    endDateRaw: string;
  } {
    const normalizedStartRaw = (startDate || '').trim();
    const normalizedEndRaw = (endDate || '').trim();
    const parsedStart = this.parseDateInput(normalizedStartRaw, false);
    const parsedEnd = this.parseDateInput(normalizedEndRaw, true);

    return {
      startDate: parsedStart,
      endDate: parsedEnd,
      startDateRaw: parsedStart ? normalizedStartRaw : '',
      endDateRaw: parsedEnd ? normalizedEndRaw : '',
    };
  }

  private parseDateInput(raw: string, endOfDay: boolean): Date | undefined {
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return undefined;
    }

    const time = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const parsed = new Date(`${raw}${time}`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  private compareNoticeNums(
    left: number,
    right: number,
    sortOrder: 'asc' | 'desc',
  ): number {
    return sortOrder === 'asc' ? left - right : right - left;
  }

  private buildCacheInsertionEntries(params: {
    cacheOnlyItems: ReturnType<
      NoticesQueryService['mapCachedNoticeToListItem']
    >[];
    sortOrder: 'asc' | 'desc';
    archiveTotal: number;
  }): {
    position: number;
    item: ReturnType<NoticesQueryService['mapCachedNoticeToListItem']>;
  }[] {
    const entries: {
      position: number;
      item: ReturnType<NoticesQueryService['mapCachedNoticeToListItem']>;
    }[] = [];

    for (let index = 0; index < params.cacheOnlyItems.length; index += 1) {
      const item = params.cacheOnlyItems[index];
      const position =
        params.sortOrder === 'asc' ? params.archiveTotal + index : index;

      entries.push({
        position,
        item,
      });
    }

    return entries.sort((a, b) => a.position - b.position);
  }

  private mergePageItems(params: {
    startIndex: number;
    endIndex: number;
    cacheInsertionMap: Map<
      number,
      ReturnType<NoticesQueryService['mapCachedNoticeToListItem']>
    >;
    archiveItems: Awaited<
      ReturnType<NoticeArchiveService['getArchiveNoticesByOffset']>
    >['items'];
  }): Array<
    | ReturnType<NoticesQueryService['mapCachedNoticeToListItem']>
    | Awaited<
        ReturnType<NoticeArchiveService['getArchiveNoticesByOffset']>
      >['items'][number]
  > {
    const merged: Array<
      | ReturnType<NoticesQueryService['mapCachedNoticeToListItem']>
      | Awaited<
          ReturnType<NoticeArchiveService['getArchiveNoticesByOffset']>
        >['items'][number]
    > = [];

    let archiveCursor = 0;

    for (
      let position = params.startIndex;
      position < params.endIndex;
      position += 1
    ) {
      const cacheItem = params.cacheInsertionMap.get(position);
      if (cacheItem) {
        merged.push(cacheItem);
        continue;
      }

      const archiveItem = params.archiveItems[archiveCursor];
      if (archiveItem) {
        merged.push(archiveItem);
        archiveCursor += 1;
      }
    }

    return merged;
  }
}
