import { NoticeSearchService } from './notice-search.service';

describe('NoticeSearchService', () => {
  it('fetches and returns the requested archive page when crawler results are not merged', async () => {
    const archiveItems = [
      {
        num: 2200100,
        subject: '두 번째 페이지 법률안',
        proposerCategory: '정부',
        committee: '법제사법위원회',
        link: 'https://example.test/notices/2200100',
        contentId: 'content-2200100',
        isDone: false,
        aiSummary: null,
        aiSummaryStatus: 'not_requested',
        attachments: { pdfFile: '', hwpFile: '' },
        archiveStartedAt: null,
      },
    ];
    const noticeArchiveService = {
      getArchiveNotices: jest.fn().mockResolvedValue({
        items: archiveItems,
        total: 201,
      }),
    };
    const crawlingCoreService = {
      search: jest.fn(),
      searchDone: jest.fn(),
    };
    const service = new NoticeSearchService(
      noticeArchiveService as any,
      crawlingCoreService as any,
    );

    const result = await service.searchNotices({
      keyword: '법률안',
      page: 4,
      limit: 50,
    });

    expect(noticeArchiveService.getArchiveNotices).toHaveBeenCalledWith(
      expect.objectContaining({ page: 4, limit: 50 }),
    );
    expect(crawlingCoreService.search).not.toHaveBeenCalled();
    expect(crawlingCoreService.searchDone).not.toHaveBeenCalled();
    expect(result.items).toEqual([
      expect.objectContaining({ num: 2200100, isArchived: true }),
    ]);
    expect(result.total).toBe(201);
  });
});
