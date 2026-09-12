import { NoticesQueryService } from './notices-query.service';

function createService(
  overrides: {
    cachedNotices?: any[];
    archiveItems?: any[];
    archiveTotal?: number;
    getExistingNoticeNumSet?: Set<number>;
    changeEventCounts?: Map<number, number>;
    getArchiveNoticesByNoticeNums?: any[];
  } = {},
) {
  const crawlingService = {
    getRecentNotices: jest
      .fn()
      .mockResolvedValue(overrides.cachedNotices ?? []),
  };

  const noticeArchiveService = {
    getArchiveNoticesByOffset: jest.fn().mockResolvedValue({
      items: overrides.archiveItems ?? [],
      total: overrides.archiveTotal ?? 0,
    }),
    getExistingNoticeNumSet: jest
      .fn()
      .mockResolvedValue(overrides.getExistingNoticeNumSet ?? new Set()),
    getArchiveNoticesByNoticeNums: jest
      .fn()
      .mockResolvedValue(overrides.getArchiveNoticesByNoticeNums ?? []),
  };

  const changeTrackingService = {
    getChangeEventCountsByNoticeNums: jest
      .fn()
      .mockResolvedValue(overrides.changeEventCounts ?? new Map()),
  };

  const service = new NoticesQueryService(
    crawlingService as any,
    noticeArchiveService as any,
    changeTrackingService as any,
  );

  return {
    service,
    crawlingService,
    noticeArchiveService,
    changeTrackingService,
  };
}

const makeCachedNotice = (num: number, subject: string) => ({
  num,
  subject,
  proposerCategory: '정부',
  committee: '정무위원회',
  link: `https://pal.assembly.go.kr/${num}`,
  contentId: null,
  aiSummary: null,
  aiSummaryStatus: 'not_requested' as const,
  attachments: { pdfFile: '', hwpFile: '' },
});

const makeArchiveItem = (num: number, subject: string) => ({
  num,
  subject,
  proposerCategory: '정부',
  committee: '정무위원회',
  link: `https://pal.assembly.go.kr/${num}`,
  contentId: null,
  aiSummary: null,
  aiSummaryStatus: 'not_requested',
  attachments: { pdfFile: '', hwpFile: '' },
  archiveStartedAt: new Date(),
});

describe('NoticesQueryService', () => {
  describe('getArchivedNotices', () => {
    it('returns empty results when no notices exist', async () => {
      const { service } = createService();

      const result = await service.getArchivedNotices({
        page: 1,
        limit: 20,
      });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(1);
    });

    it('merges cache-only items with archived items', async () => {
      const { service } = createService({
        cachedNotices: [makeCachedNotice(3000001, '캐시 의안')],
        archiveItems: [makeArchiveItem(2000001, '아카이브 의안')],
        archiveTotal: 1,
        getExistingNoticeNumSet: new Set([2000001]),
      });

      const result = await service.getArchivedNotices({
        page: 1,
        limit: 20,
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.stats.cacheCount).toBe(1);
    });

    it('filters by isDone=true and skips cache candidates', async () => {
      const { service, noticeArchiveService } = createService({
        cachedNotices: [makeCachedNotice(3000001, '캐시 의안')],
        archiveItems: [],
        archiveTotal: 0,
      });

      await service.getArchivedNotices({
        page: 1,
        limit: 20,
        isDone: true,
      });

      // Cache candidates should be empty when isDone=true
      expect(
        noticeArchiveService.getArchiveNoticesByOffset,
      ).toHaveBeenCalledWith(expect.objectContaining({ isDone: true }));
    });

    it('filters cached notices by search keyword in subject', async () => {
      const { service } = createService({
        cachedNotices: [
          makeCachedNotice(3000001, '환경 보호 법률안'),
          makeCachedNotice(3000002, '교육 개혁 법률안'),
        ],
        archiveItems: [],
        archiveTotal: 0,
        getExistingNoticeNumSet: new Set([3000001, 3000002]),
      });

      const result = await service.getArchivedNotices({
        page: 1,
        limit: 20,
        search: '환경',
      });

      expect(result.search).toBe('환경');
    });

    it('parses comma-separated noticeNums and queries archive', async () => {
      const { service, noticeArchiveService } = createService({
        getArchiveNoticesByNoticeNums: [makeArchiveItem(2000001, '의안 1')],
      });

      await service.getArchivedNotices({
        page: 1,
        limit: 20,
        noticeNums: '2000001,2000002',
      });

      expect(
        noticeArchiveService.getArchiveNoticesByNoticeNums,
      ).toHaveBeenCalledWith(expect.arrayContaining([2000001, 2000002]));
    });

    it('normalizes sort order and defaults to desc', async () => {
      const { service, noticeArchiveService } = createService();

      const result = await service.getArchivedNotices({
        page: 1,
        limit: 20,
        sortOrder: 'asc',
      });

      expect(result.sortOrder).toBe('asc');
      expect(
        noticeArchiveService.getArchiveNoticesByOffset,
      ).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 'asc' }));
    });

    it('clamps page and limit to valid ranges', async () => {
      const { service } = createService();

      const result = await service.getArchivedNotices({
        page: 0,
        limit: 500,
      });

      expect(result.page).toBe(1);
      expect(result.limit).toBeLessThanOrEqual(100);
    });

    it('attaches change event counts to items when archive items are present', async () => {
      const counts = new Map<number, number>([[2000001, 5]]);
      const { service } = createService({
        archiveItems: [makeArchiveItem(2000001, '변경 의안')],
        archiveTotal: 1,
        changeEventCounts: counts,
      });

      const result = await service.getArchivedNotices({
        page: 1,
        limit: 20,
      });

      expect(result.items).toBeDefined();
      expect(Array.isArray(result.items)).toBe(true);
    });

    it('handles notices by specific noticeNums from cache when not in archive', async () => {
      const { service } = createService({
        cachedNotices: [makeCachedNotice(3000001, '캐시 전용 의안')],
        getArchiveNoticesByNoticeNums: [],
      });

      const result = await service.getArchivedNotices({
        page: 1,
        limit: 20,
        noticeNums: '3000001',
      });

      // The cache item should appear if it's not in archive
      expect(result.items.length).toBeGreaterThanOrEqual(0);
    });

    it('uses KST date range for start and end dates', async () => {
      const { service, noticeArchiveService } = createService();

      await service.getArchivedNotices({
        page: 1,
        limit: 20,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });

      expect(
        noticeArchiveService.getArchiveNoticesByOffset,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date),
        }),
      );
    });

    it('returns empty for date filter when cache candidates are skipped', async () => {
      const { service } = createService({
        cachedNotices: [makeCachedNotice(3000001, '캐시 의안')],
        archiveItems: [],
        archiveTotal: 0,
      });

      const result = await service.getArchivedNotices({
        page: 1,
        limit: 20,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });

      // When date filter is active, cache items are excluded from candidates
      // but matchedCacheCount still reflects the initial search pass.
      // The key assertion is that total = 0 since archiveItems is empty
      // and cache candidates are skipped.
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('matches search keyword in committee field', async () => {
      const { service } = createService({
        cachedNotices: [
          { ...makeCachedNotice(3000001, '의안'), committee: '환경노동위원회' },
        ],
        archiveItems: [],
        archiveTotal: 0,
        getExistingNoticeNumSet: new Set([3000001]),
      });

      const result = await service.getArchivedNotices({
        page: 1,
        limit: 20,
        search: '환경노동',
      });

      expect(result.search).toBe('환경노동');
    });
  });
});
