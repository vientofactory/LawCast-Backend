import { APP_CONSTANTS } from '../../../config/app.config';
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
      contentId: 'PRC_TEST_2200001',
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
        getSourceDeletedNoticeNumSet: async () => new Set(),
        getArchiveStartedAtByNoticeNums: async () =>
          new Map([[notice.num, new Date()]]),
        getContentProposalDateByNoticeNums: async () => new Map(),
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
      'PRC_TEST_2200001',
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

  it('enqueues contentId-less notices and routes every item by contentId', async () => {
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
      getSourceDeletedNoticeNumSet: jest.fn(async () => new Set<number>()),
      getArchiveStartedAtByNoticeNums: jest.fn(
        async () => new Map<number, Date>(),
      ),
      getContentProposalDateByNoticeNums: jest.fn(
        async () => new Map<number, string>(),
      ),
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
    const notice = (num: number, contentId: string | null) => ({
      num,
      subject: `의안 ${num}`,
      proposerCategory: '의원',
      committee: '산업통상부',
      link: `https://example.com/${num}`,
      contentId,
      attachments: { pdfFile: null, hwpFile: null },
      aiSummary: null,
      aiSummaryStatus: 'not_requested' as const,
    });

    // PAL row (contentId) -> Likms path; NSM row (no contentId) -> NsmLmSts capture.
    await retry.enqueue(notice(2220590, 'PRC_TEST_2220590'), {
      billNo: '2220590',
    });
    await retry.enqueue(notice(2220591, null), { billNo: '2220591' });

    expect(await retry.getQueueLength()).toBe(2);

    await retry.drain();

    expect(fetchAndUpdateProposalReason).toHaveBeenCalledTimes(2);
    expect(fetchAndUpdateProposalReason).toHaveBeenCalledWith(
      2220590,
      '2220590',
      'PRC_TEST_2220590',
    );
    expect(fetchAndUpdateProposalReason).toHaveBeenCalledWith(
      2220591,
      '2220591',
      null,
    );
    expect(await retry.getQueueLength()).toBe(0);
  });

  /**
   * The candidate page is ordered by attempt history, so a drain that does not
   * stamp what it tried leaves the next tick re-seeding the same rows - the
   * production wedge where 20 unrecoverable bills were retried every 15 minutes
   * and the 180 recoverable ones behind them were never reached
   * (agent_memories/39-likms-reason-backfill-throughput/).
   */
  const buildRetryHarness = (options: {
    proposalReasonByNum: Record<number, string | null>;
    recordAttempts?: jest.Mock;
    archiveStartedAtByNum?: Record<number, Date>;
    proposalDateByNum?: Record<number, string>;
  }) => {
    let storedQueue: unknown = null;
    const cacheService = {
      getObject: jest.fn(async () => storedQueue),
      setObject: jest.fn(async (_key: string, value: unknown) => {
        storedQueue = value;
        return true;
      }),
      // `setQueue([])` deletes the key instead of storing an empty array, so
      // the double has to clear its stored copy the way Redis would.
      deleteKey: jest.fn(async () => {
        storedQueue = null;
        return true;
      }),
      getRecentNotices: jest.fn(async () => []),
      updateCache: jest.fn(async () => undefined),
    };
    const fetchAndUpdateProposalReason = jest.fn(
      async (num: number) => options.proposalReasonByNum[num] ?? null,
    );
    const updateSummaryStateByNoticeNum = jest.fn(async () => undefined);
    const sendNotifications = jest.fn(async () => undefined);
    const summaryByNum: Record<number, string> = { 2220590: '요약' };
    const retry = new CrawlingSchedulerProposalRetry({
      cacheService: cacheService as any,
      archiveOrchestratorService: {
        fetchAndUpdateProposalReason,
      } as any,
      summaryGenerationService: {
        generateSummaryForNotice: jest.fn(async (notice: { num: number }) => ({
          aiSummary: summaryByNum[notice.num] ?? null,
          aiSummaryStatus: 'ready',
        })),
        isAiSummaryEnabled: () => true,
      } as any,
      notificationOrchestratorService: {
        sendNotifications,
      } as any,
      noticeArchiveService: {
        getNsmBillNumberByNoticeNums: jest.fn(
          async () => new Map<number, string>(),
        ),
        getSourceDeletedNoticeNumSet: jest.fn(async () => new Set<number>()),
        getArchiveStartedAtByNoticeNums: jest.fn(
          async (nums: number[]) =>
            new Map(
              nums
                .filter((num) => options.archiveStartedAtByNum?.[num])
                .map((num) => [
                  num,
                  options.archiveStartedAtByNum?.[num] as Date,
                ]),
            ),
        ),
        getContentProposalDateByNoticeNums: jest.fn(
          async (nums: number[]) =>
            new Map(
              nums
                .filter((num) => options.proposalDateByNum?.[num])
                .map((num) => [
                  num,
                  options.proposalDateByNum?.[num] as string,
                ]),
            ),
        ),
        updateSummaryStateByNoticeNum,
        ...(options.recordAttempts
          ? { recordProposalReasonAttempts: options.recordAttempts }
          : {}),
      } as any,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    const notice = (num: number) => ({
      num,
      subject: `의안 ${num}`,
      proposerCategory: '의원',
      committee: '산업통상부',
      link: `https://example.com/${num}`,
      contentId: `PRC_${num}`,
      attachments: { pdfFile: null, hwpFile: null },
      aiSummary: null,
      aiSummaryStatus: 'not_requested' as const,
    });

    return {
      retry,
      notice,
      updateSummaryStateByNoticeNum,
      sendNotifications,
      cacheService,
    };
  };

  it('stamps every attempted bill, including the ones whose reason could not be recovered', async () => {
    const recordAttempts = jest.fn(async (nums: number[]) => nums.length);
    const { retry, notice } = buildRetryHarness({
      proposalReasonByNum: { 2220590: '복구된 제안이유', 2220591: null },
      recordAttempts,
    });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.enqueue(notice(2220591), { billNo: '2220591' });
    await retry.drain();

    // The unrecoverable bill is dropped from the queue but still counts as an
    // attempt: its stamp is what moves the next candidate page past it.
    expect(recordAttempts).toHaveBeenCalledTimes(1);
    expect(recordAttempts.mock.calls[0][0]).toEqual([2220590, 2220591]);
    expect(await retry.getQueueLength()).toBe(0);
  });

  it('keeps the drain result when the attempt stamp cannot be written', async () => {
    const recordAttempts = jest.fn(async () => {
      throw new Error('database is locked');
    });
    const { retry, notice, updateSummaryStateByNoticeNum } = buildRetryHarness({
      proposalReasonByNum: { 2220590: '복구된 제안이유' },
      recordAttempts,
    });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });

    await expect(retry.drain()).resolves.toBeUndefined();

    // Losing a stamp costs one repeated attempt; it must never discard the
    // reason and summary this pass already produced.
    expect(updateSummaryStateByNoticeNum).toHaveBeenCalledWith(
      2220590,
      '요약',
      'ready',
    );
  });

  it('skips the regular notification for a recovery archived past the notify window', async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { retry, notice, sendNotifications, cacheService } =
      buildRetryHarness({
        proposalReasonByNum: { 2220590: '복구된 제안이유' },
        archiveStartedAtByNum: { 2220590: thirtyDaysAgo },
      });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.drain();

    // The recovered data still flows into the cache and the archive; only the
    // second "new bill" ping stays silent.
    expect(cacheService.updateCache).toHaveBeenCalled();
    expect(sendNotifications).not.toHaveBeenCalled();
    expect(await retry.getQueueLength()).toBe(0);
  });

  it('still notifies a recovery archived inside the notify window', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const { retry, notice, sendNotifications } = buildRetryHarness({
      proposalReasonByNum: { 2220590: '복구된 제안이유' },
      archiveStartedAtByNum: { 2220590: oneHourAgo },
    });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.drain();

    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('notifies when the archive age is unknown instead of silently dropping', async () => {
    const { retry, notice, sendNotifications } = buildRetryHarness({
      proposalReasonByNum: { 2220590: '복구된 제안이유' },
    });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.drain();

    // No archive-age row: fail open so a genuinely new bill is never muted by
    // a lookup miss.
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('evicts age-expired queue items without notifying long-archived bills', async () => {
    const twoDaysAgoIso = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let storedQueue: unknown = [
      {
        notice: {
          num: 2220590,
          subject: '의안 2220590',
          proposerCategory: '의원',
          committee: '산업통상부',
          link: 'https://example.com/2220590',
          contentId: 'PRC_2220590',
          attachments: { pdfFile: null, hwpFile: null },
          aiSummary: null,
          aiSummaryStatus: 'not_requested' as const,
        },
        billNo: '2220590',
        retryCount: 0,
        queuedAtIso: twoDaysAgoIso,
      },
    ];
    const cacheService = {
      getObject: jest.fn(async () => storedQueue),
      setObject: jest.fn(async (_key: string, value: unknown) => {
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
    const fetchAndUpdateProposalReason = jest.fn(async () => '이유');
    const sendNotifications = jest.fn(async () => undefined);
    const retry = new CrawlingSchedulerProposalRetry({
      cacheService: cacheService as any,
      archiveOrchestratorService: {
        fetchAndUpdateProposalReason,
      } as any,
      summaryGenerationService: {} as any,
      notificationOrchestratorService: { sendNotifications } as any,
      noticeArchiveService: {
        getNsmBillNumberByNoticeNums: jest.fn(
          async () => new Map<number, string>(),
        ),
        getSourceDeletedNoticeNumSet: jest.fn(async () => new Set<number>()),
        getArchiveStartedAtByNoticeNums: jest.fn(
          async () => new Map([[2220590, thirtyDaysAgo]]),
        ),
        getContentProposalDateByNoticeNums: jest.fn(
          async () => new Map<number, string>(),
        ),
        updateSummaryStateByNoticeNum: jest.fn(async () => undefined),
      } as any,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    await retry.drain();

    // Evicted by queue age, so no fetch was attempted; long-archived, so no
    // fallback ping either.
    expect(fetchAndUpdateProposalReason).not.toHaveBeenCalled();
    expect(sendNotifications).not.toHaveBeenCalled();
    expect(await retry.getQueueLength()).toBe(0);
  });

  it('skips the at-capacity fallback ping for a long-archived bill', async () => {
    const { MAX_SIZE } = APP_CONSTANTS.ARCHIVE_SYNC.PROPOSAL_REASON_RETRY_QUEUE;
    const filler = Array.from({ length: MAX_SIZE }, (_, index) => ({
      notice: {
        num: 2300000 + index,
        subject: `의안 ${2300000 + index}`,
        proposerCategory: '의원',
        committee: '산업통상부',
        link: `https://example.com/${2300000 + index}`,
        contentId: null,
        attachments: { pdfFile: null, hwpFile: null },
        aiSummary: null,
        aiSummaryStatus: 'not_requested' as const,
      },
      billNo: `${2300000 + index}`,
      retryCount: 0,
      queuedAtIso: new Date().toISOString(),
    }));
    const cacheService = {
      getObject: jest.fn(async () => filler),
      setObject: jest.fn(async () => true),
      deleteKey: jest.fn(async () => true),
      getRecentNotices: jest.fn(async () => []),
      updateCache: jest.fn(async () => undefined),
    };
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sendNotifications = jest.fn(async () => undefined);
    const retry = new CrawlingSchedulerProposalRetry({
      cacheService: cacheService as any,
      archiveOrchestratorService: {} as any,
      summaryGenerationService: {} as any,
      notificationOrchestratorService: { sendNotifications } as any,
      noticeArchiveService: {
        getArchiveStartedAtByNoticeNums: jest.fn(
          async () => new Map([[2220590, thirtyDaysAgo]]),
        ),
        getContentProposalDateByNoticeNums: jest.fn(
          async () => new Map<number, string>(),
        ),
      } as any,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    await retry.enqueue(
      {
        num: 2220590,
        subject: '의안 2220590',
        proposerCategory: '의원',
        committee: '산업통상부',
        link: 'https://example.com/2220590',
        contentId: null,
        attachments: { pdfFile: null, hwpFile: null },
        aiSummary: null,
        aiSummaryStatus: 'not_requested' as const,
      } as any,
      { billNo: '2220590' },
    );

    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it('skips a recovery proposed long ago even when the archive row is fresh', async () => {
    // Replay of production bill 2216118: proposed 2026-01-16, first archived
    // the day before the recovery, so the archive-age clock alone passes it.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const { retry, notice, sendNotifications, cacheService } =
      buildRetryHarness({
        proposalReasonByNum: { 2220590: '복구된 제안이유' },
        archiveStartedAtByNum: { 2220590: oneHourAgo },
        proposalDateByNum: { 2220590: '2026-01-16' },
      });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.drain();

    expect(cacheService.updateCache).toHaveBeenCalled();
    expect(sendNotifications).not.toHaveBeenCalled();
    expect(await retry.getQueueLength()).toBe(0);
  });

  it('still notifies a recovery proposed inside the notify window', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const todayIso = new Date().toISOString().slice(0, 10);
    const { retry, notice, sendNotifications } = buildRetryHarness({
      proposalReasonByNum: { 2220590: '복구된 제안이유' },
      archiveStartedAtByNum: { 2220590: oneHourAgo },
      proposalDateByNum: { 2220590: todayIso },
    });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.drain();

    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('notifies when the stored proposal date is not a calendar date', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const { retry, notice, sendNotifications } = buildRetryHarness({
      proposalReasonByNum: { 2220590: '복구된 제안이유' },
      archiveStartedAtByNum: { 2220590: oneHourAgo },
      proposalDateByNum: { 2220590: '심사 예정' },
    });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.drain();

    // Unparsable dates fail open: the archive clock is fresh, so the bill is
    // notified rather than muted over a malformed string.
    expect(sendNotifications).toHaveBeenCalledTimes(1);
  });

  it('parses dotted archive dates such as 2026. 6. 10. as stale', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const { retry, notice, sendNotifications } = buildRetryHarness({
      proposalReasonByNum: { 2220590: '복구된 제안이유' },
      archiveStartedAtByNum: { 2220590: oneHourAgo },
      proposalDateByNum: { 2220590: '2026. 6. 10.' },
    });

    await retry.enqueue(notice(2220590), { billNo: '2220590' });
    await retry.drain();

    expect(sendNotifications).not.toHaveBeenCalled();
  });
});
