import { CrawlingSchedulerProposalRetry } from './crawling-scheduler-proposal-retry';

describe('CrawlingSchedulerProposalRetry', () => {
  it('prunes PAL-upgraded queue entries before fetching NSM detail', async () => {
    let storedQueue: unknown = null;
    const cacheService = {
      getObject: jest.fn(async () => storedQueue),
      setObject: jest.fn(async (_key, value) => {
        storedQueue = value;
        return true;
      }),
      deleteKey: jest.fn(async () => {
        storedQueue = null;
        return true;
      }),
      getRecentNotices: jest.fn(async () => []),
      updateCache: jest.fn(async () => undefined),
    };
    const fetchAndUpdateProposalReason = jest.fn(async () => null);
    const noticeArchiveService = {
      getNsmBillNumberByNoticeNums: jest.fn(
        async () => new Map<number, string>(),
      ),
      getArchivedNullContentIdNums: jest.fn(
        async () => new Set<number>([2220591]),
      ),
      getSourceDeletedNoticeNumSet: jest.fn(async () => new Set<number>()),
      updateSummaryStateByNoticeNum: jest.fn(async () => undefined),
    };
    const retry = new CrawlingSchedulerProposalRetry({
      cacheService: cacheService as any,
      archiveOrchestratorService: {
        fetchAndUpdateProposalReason,
      } as any,
      summaryGenerationService: {} as any,
      notificationOrchestratorService: {
        sendNotifications: jest.fn(async () => undefined),
      } as any,
      noticeArchiveService: noticeArchiveService as any,
      logger: {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });
    const notice = (num: number) => ({
      num,
      subject: `의안 ${num}`,
      proposerCategory: '의원',
      committee: '산업통상부',
      link: `https://example.com/${num}`,
      contentId: null,
      attachments: { pdfFile: null, hwpFile: null },
      aiSummary: null,
      aiSummaryStatus: 'not_requested' as const,
    });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.enqueue(notice(2220591), { billNo: '2220591' });
    await retry.drain();

    expect(
      noticeArchiveService.getArchivedNullContentIdNums,
    ).toHaveBeenCalledWith([2220590, 2220591]);
    expect(fetchAndUpdateProposalReason).toHaveBeenCalledTimes(1);
    expect(fetchAndUpdateProposalReason).toHaveBeenCalledWith(
      2220591,
      '2220591',
    );
  });
});
