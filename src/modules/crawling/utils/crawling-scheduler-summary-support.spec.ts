import { CrawlingSchedulerSummarySupport } from './crawling-scheduler-summary-support';

describe('CrawlingSchedulerSummarySupport', () => {
  const makeNotice = (num: number) => ({
    num,
    subject: `테스트 입법예고 ${num}`,
    proposerCategory: '정부',
    committee: '법제사법위원회',
    link: `https://example.com/notices/${num}`,
    contentId: `content-${num}`,
    aiSummary: null,
    aiSummaryStatus: 'unavailable' as const,
    attachments: { pdfFile: '', hwpFile: '' },
  });

  it('only refreshes Redis with retries that were successfully persisted', async () => {
    const cacheService = {
      updateCache: jest.fn().mockResolvedValue(undefined),
    } as any;
    const noticeArchiveService = {
      updateSummaryStateByNoticeNum: jest
        .fn()
        .mockRejectedValueOnce(new Error('DB busy'))
        .mockResolvedValueOnce(undefined),
    } as any;
    const summaryGenerationService = {
      generateSummaryForNotice: jest.fn().mockResolvedValue({
        aiSummary: '새 요약',
        aiSummaryStatus: 'ready',
      }),
    } as any;
    const logger = {
      log: jest.fn(),
      warn: jest.fn(),
    };

    const support = new CrawlingSchedulerSummarySupport({
      cacheService,
      noticeArchiveService,
      summaryGenerationService,
      logger,
    });

    const notices = [makeNotice(1), makeNotice(2)];
    const existingNoticeMap = new Map(
      notices.map((notice) => [notice.num, notice]),
    );

    await support.retryUnavailableSummariesInBackground(
      notices,
      existingNoticeMap,
    );

    expect(cacheService.updateCache).toHaveBeenCalledTimes(1);
    expect(cacheService.updateCache).toHaveBeenCalledWith([
      expect.objectContaining({
        num: 2,
        aiSummary: '새 요약',
        aiSummaryStatus: 'ready',
      }),
    ]);
    expect(cacheService.updateCache).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ num: 1, aiSummaryStatus: 'ready' }),
      ]),
    );
  });
});
