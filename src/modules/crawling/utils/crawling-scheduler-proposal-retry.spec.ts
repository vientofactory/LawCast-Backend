import { CrawlingSchedulerProposalRetry } from './crawling-scheduler-proposal-retry';

describe('CrawlingSchedulerProposalRetry', () => {
  it('drains an ended notice and preserves isDone through summary, cache, and notification updates', async () => {
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
    const notice = {
      num: 2200001,
      subject: '종료된 입법예고',
      proposerCategory: '의원',
      committee: '법사위',
      link: 'https://example.com/2200001',
      contentId: null,
      isDone: true,
      attachments: { pdfFile: '', hwpFile: '' },
    };
    const proposalReason = '첫 줄\n둘째 줄';
    const fetchAndUpdateProposalReason = jest.fn(async () => proposalReason);
    const generateSummaryForNotice = jest.fn(async () => ({
      aiSummary: '요약',
      aiSummaryStatus: 'ready',
    }));
    const updateSummaryStateByNoticeNum = jest.fn(async () => undefined);
    const sendNotifications = jest.fn(async () => undefined);
    const retry = new CrawlingSchedulerProposalRetry({
      cacheService: cacheService as any,
      archiveOrchestratorService: { fetchAndUpdateProposalReason } as any,
      summaryGenerationService: {
        generateSummaryForNotice,
        isAiSummaryEnabled: () => true,
      } as any,
      notificationOrchestratorService: { sendNotifications } as any,
      noticeArchiveService: {
        getNsmBillNumberByNoticeNums: async () =>
          new Map([[notice.num, '2200001']]),
        getArchivedNullContentIdNums: async () => new Set([notice.num]),
        getSourceDeletedNoticeNumSet: async () => new Set(),
        updateSummaryStateByNoticeNum,
      } as any,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    await retry.enqueue(notice, { billNo: '2200001' });
    await retry.drain();

    const enriched = {
      ...notice,
      proposalReason,
      aiSummary: '요약',
      aiSummaryStatus: 'ready',
    };
    expect(fetchAndUpdateProposalReason).toHaveBeenCalledWith(
      notice.num,
      '2200001',
    );
    expect(generateSummaryForNotice).toHaveBeenCalledWith({
      ...notice,
      proposalReason,
    });
    expect(updateSummaryStateByNoticeNum).toHaveBeenCalledWith(
      notice.num,
      '요약',
      'ready',
    );
    expect(cacheService.updateCache).toHaveBeenCalledWith([enriched]);
    expect(sendNotifications).toHaveBeenCalledWith([enriched]);
    expect(await retry.getQueueLength()).toBe(0);
    expect(cacheService.deleteKey).toHaveBeenCalledTimes(1);
  });

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
