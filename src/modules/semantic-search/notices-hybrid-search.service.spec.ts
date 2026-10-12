import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NoticesQueryService } from '../crawling/notices-query.service';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { SemanticSearchService } from './semantic-search.service';
import { NoticesHybridSearchService } from './notices-hybrid-search.service';

describe('NoticesHybridSearchService', () => {
  const STAMP = '2026-10-02T12:00:00+00:00';

  let searchSemantic: jest.Mock<(query: string, k: number) => Promise<unknown>>;
  let getArchivedNotices: jest.Mock<(query: unknown) => Promise<unknown>>;
  let getCacheOnlySearchMatches: jest.Mock<
    (params: unknown) => Promise<unknown>
  >;
  let parseDateRange: jest.Mock<(...args: unknown[]) => unknown>;
  let getArchiveNoticesByRankedNums: jest.Mock<
    (params: unknown) => Promise<unknown>
  >;
  let getArchiveCount: jest.Mock<() => Promise<number>>;
  let getChangeEventCountsByNoticeNums: jest.Mock<
    (noticeNums: number[]) => Promise<Map<number, number>>
  >;
  let service: NoticesHybridSearchService;

  const archiveItem = (
    num: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    num,
    subject: `법률안 ${num}`,
    proposerCategory: '의원',
    committee: '법제사법위원회',
    link: `http://example.test/${num}`,
    contentId: null,
    isDone: false,
    aiSummary: null,
    aiSummaryStatus: 'not_requested',
    attachments: { pdfFile: '', hwpFile: '' },
    lifecycleStatus: 'active',
    sourceDeletedAt: null,
    archiveStartedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  });

  const hit = (noticeNum: number, score = 0.7) => ({
    noticeNum,
    subject: `법률안 ${noticeNum}`,
    committee: '법제사법위원회',
    section: 'body',
    score,
    excerpt: `본문 ${noticeNum}`,
  });

  const semanticResponse = (overrides: Record<string, unknown> = {}) => ({
    query: '질의',
    mode: 'semantic',
    fallbackReason: null,
    lastUpdateAt: STAMP,
    results: [],
    weakResults: [],
    ...overrides,
  });

  const baseParams = (overrides: Record<string, unknown> = {}) => ({
    searchMode: 'semantic' as const,
    search: '임대차',
    page: 1,
    limit: 20,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    searchSemantic = jest.fn<(query: string, k: number) => Promise<unknown>>();
    getArchivedNotices = jest
      .fn<(query: unknown) => Promise<unknown>>()
      .mockResolvedValue({
        items: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1,
        search: '',
        stats: {
          cacheCount: 0,
          matchedCacheCount: 0,
          archiveCount: 0,
          totalArchiveCount: 0,
          mergedCount: 0,
        },
      });
    getCacheOnlySearchMatches = jest
      .fn<(params: unknown) => Promise<unknown>>()
      .mockResolvedValue([]);
    parseDateRange = jest
      .fn<(...args: unknown[]) => unknown>()
      .mockReturnValue({
        startDate: undefined,
        endDate: undefined,
        startDateRaw: '',
        endDateRaw: '',
      });
    getArchiveNoticesByRankedNums = jest
      .fn<(params: unknown) => Promise<unknown>>()
      .mockResolvedValue({ items: [], total: 0 });
    getArchiveCount = jest.fn<() => Promise<number>>().mockResolvedValue(0);
    getChangeEventCountsByNoticeNums = jest
      .fn<(noticeNums: number[]) => Promise<Map<number, number>>>()
      .mockResolvedValue(new Map());

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'semanticSearch.hybridMaxNotices') return 100;
        return undefined;
      }),
    } as unknown as ConfigService;

    service = new NoticesHybridSearchService(
      configService,
      { searchSemantic } as unknown as SemanticSearchService,
      {
        getArchivedNotices,
        getCacheOnlySearchMatches,
        parseDateRange,
      } as unknown as NoticesQueryService,
      {
        getArchiveNoticesByRankedNums,
        getArchiveCount,
      } as unknown as NoticeArchiveService,
      {
        getChangeEventCountsByNoticeNums,
      } as unknown as ChangeTrackingService,
    );
  });

  it('keeps the keyword path untouched in keyword mode', async () => {
    const result = await service.search(
      baseParams({ searchMode: 'keyword', search: '임대차' }),
    );

    expect(getArchivedNotices).toHaveBeenCalledWith(
      expect.objectContaining({ search: '임대차', page: 1, limit: 20 }),
    );
    expect(searchSemantic).not.toHaveBeenCalled();
    expect(result.searchMode).toBe('keyword');
    expect(result.appliedMode).toBe('keyword');
    expect(result.semantic).toBeNull();
  });

  it('takes the keyword path when there is no query', async () => {
    const result = await service.search(
      baseParams({ searchMode: 'auto', search: '   ' }),
    );

    expect(getArchivedNotices).toHaveBeenCalled();
    expect(searchSemantic).not.toHaveBeenCalled();
    expect(result.appliedMode).toBe('keyword');
  });

  it('hydrates ranked notice numbers and preserves relevance order', async () => {
    searchSemantic.mockResolvedValue(
      semanticResponse({ results: [hit(3, 0.91), hit(1, 0.8)] }),
    );
    getArchiveNoticesByRankedNums.mockResolvedValue({
      items: [archiveItem(3), archiveItem(1)],
      total: 2,
    });
    getChangeEventCountsByNoticeNums.mockResolvedValue(new Map([[3, 4]]));

    const result = await service.search(baseParams({ search: '세입자 보호' }));

    expect(getArchiveNoticesByRankedNums).toHaveBeenCalledWith(
      expect.objectContaining({ noticeNums: [3, 1] }),
    );
    expect(result.appliedMode).toBe('semantic');
    expect(result.items.map((item) => item.num)).toEqual([3, 1]);
    expect(result.items[0].relevance).toEqual({
      score: 0.91,
      section: 'body',
      excerpt: '본문 3',
      weak: false,
    });
    expect(result.items[0].changeEventCount).toBe(4);
    expect(result.semantic?.mode).toBe('semantic');
    expect(result.semantic?.candidateTotal).toBe(2);
  });

  it('reflects items dropped by the archive post-filters', async () => {
    searchSemantic.mockResolvedValue(
      semanticResponse({ results: [hit(3), hit(1)] }),
    );
    // The archive hydration applied the filters and dropped notice 1.
    getArchiveNoticesByRankedNums.mockResolvedValue({
      items: [archiveItem(3)],
      total: 1,
    });

    const result = await service.search(
      baseParams({ proposer: '김의원', isDone: false }),
    );

    expect(getArchiveNoticesByRankedNums).toHaveBeenCalledWith(
      expect.objectContaining({ proposer: '김의원', isDone: false }),
    );
    expect(result.items.map((item) => item.num)).toEqual([3]);
    expect(result.total).toBe(1);
    // candidateTotal is pre-filter, so it still reports the engine count.
    expect(result.semantic?.candidateTotal).toBe(2);
  });

  it('falls back to keyword results when the engine reports keyword_fallback', async () => {
    searchSemantic.mockResolvedValue(
      semanticResponse({
        mode: 'keyword_fallback',
        fallbackReason: '엔진을 사용할 수 없습니다.',
        results: [],
        weakResults: [hit(9, 0.3)],
      }),
    );

    const result = await service.search(baseParams({ searchMode: 'auto' }));

    expect(getArchivedNotices).toHaveBeenCalled();
    expect(result.appliedMode).toBe('keyword');
    expect(result.semantic?.mode).toBe('keyword_fallback');
    expect(result.semantic?.fallbackReason).toBe('엔진을 사용할 수 없습니다.');
    expect(result.semantic?.weakResults).toHaveLength(1);
  });

  it('keeps an empty clear tier empty and carries the weak tier', async () => {
    searchSemantic.mockResolvedValue(
      semanticResponse({ results: [], weakResults: [hit(9, 0.3)] }),
    );

    const result = await service.search(baseParams());

    expect(result.appliedMode).toBe('semantic');
    expect(result.items).toHaveLength(0);
    expect(getArchivedNotices).not.toHaveBeenCalled();
    expect(result.semantic?.mode).toBe('semantic');
    expect(result.semantic?.weakResults).toHaveLength(1);
  });

  it('appends cache-only keyword matches after the semantic block, deduped', async () => {
    searchSemantic.mockResolvedValue(semanticResponse({ results: [hit(3)] }));
    getArchiveNoticesByRankedNums.mockResolvedValue({
      items: [archiveItem(3)],
      total: 1,
    });
    getCacheOnlySearchMatches.mockResolvedValue([
      { ...archiveItem(3), isDone: undefined },
      { ...archiveItem(5), isDone: undefined },
    ]);

    const result = await service.search(baseParams());

    expect(getCacheOnlySearchMatches).toHaveBeenCalledWith({
      search: '임대차',
      proposer: '',
    });
    expect(result.items.map((item) => item.num)).toEqual([3, 5]);
    expect(result.total).toBe(2);
    expect(result.items[0].relevance).toBeDefined();
    expect(result.items[1].relevance).toBeUndefined();
  });

  it('skips cache-only matches when a date filter applies', async () => {
    parseDateRange.mockReturnValue({
      startDate: new Date('2026-01-01T00:00:00+09:00'),
      endDate: undefined,
      startDateRaw: '2026-01-01',
      endDateRaw: '',
    });
    searchSemantic.mockResolvedValue(semanticResponse({ results: [hit(3)] }));
    getArchiveNoticesByRankedNums.mockResolvedValue({
      items: [archiveItem(3)],
      total: 1,
    });

    await service.search(baseParams({ startDate: '2026-01-01' }));

    expect(getCacheOnlySearchMatches).not.toHaveBeenCalled();
  });

  it('skips cache-only matches when scoped to ended notices', async () => {
    searchSemantic.mockResolvedValue(semanticResponse({ results: [hit(3)] }));
    getArchiveNoticesByRankedNums.mockResolvedValue({
      items: [archiveItem(3)],
      total: 1,
    });

    await service.search(baseParams({ isDone: true }));

    expect(getCacheOnlySearchMatches).not.toHaveBeenCalled();
  });

  it('paginates the combined relevance-ordered list', async () => {
    const hits = [5, 4, 3, 2, 1].map((num, idx) => hit(num, 0.9 - idx * 0.05));
    searchSemantic.mockResolvedValue(semanticResponse({ results: hits }));
    getArchiveNoticesByRankedNums.mockResolvedValue({
      items: [5, 4, 3, 2, 1].map((num) => archiveItem(num)),
      total: 5,
    });

    const result = await service.search(baseParams({ page: 2, limit: 2 }));

    expect(result.items.map((item) => item.num)).toEqual([3, 2]);
    expect(result.total).toBe(5);
    expect(result.totalPages).toBe(3);
    expect(result.page).toBe(2);
  });

  it('rethrows a client-contract error from the engine', async () => {
    searchSemantic.mockRejectedValue(new BadRequestException('bad'));

    await expect(service.search(baseParams())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('degrades to keyword results on an unexpected engine error', async () => {
    searchSemantic.mockRejectedValue(new Error('boom'));

    const result = await service.search(baseParams({ searchMode: 'auto' }));

    expect(getArchivedNotices).toHaveBeenCalled();
    expect(result.appliedMode).toBe('keyword');
    expect(result.semantic?.mode).toBe('keyword_fallback');
  });
});
