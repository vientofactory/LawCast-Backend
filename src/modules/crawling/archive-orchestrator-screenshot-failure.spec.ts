import { DataSource } from 'typeorm';
import { type INsmBillItem } from 'pal-crawl';
import { type CachedNotice } from '../../types/cache.types';
import { fetchHtmlPage } from '../../utils/http-fetch.utils';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { NoticeArchiveSnapshotState } from '../notice/notice-archive-summary-state.entity';
import { NoticeArchiveIntegrityCheck } from '../notice/notice-archive-integrity-check.entity';
import { NoticeArchiveIntegrityState } from '../notice/notice-archive-integrity-state.entity';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { AllowSnapshotArtifactFirstFill1755043201000 } from '../../migrations/202608130001-allow-snapshot-artifact-first-fill.migration';
import { LoggerUtils } from '../../utils/logger.utils';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';

jest.mock('../../utils/http-fetch.utils', () => ({
  fetchHtmlPage: jest.fn(),
}));

const mockFetchHtmlPage = fetchHtmlPage as jest.MockedFunction<
  typeof fetchHtmlPage
>;

const makeNotice = (num: number): CachedNotice => ({
  num,
  subject: `법안 ${num}`,
  proposerCategory: '정부',
  committee: '법제사법위원회',
  link: `https://example.com/notice/${num}`,
  contentId: `content-${num}`,
  attachments: { pdfFile: '', hwpFile: '' },
  aiSummary: null,
  aiSummaryStatus: 'not_requested',
});

const makeHtmlResponse = (url: string) =>
  ({
    data: '<html>snapshot</html>',
    status: 200,
    statusText: 'OK',
    config: { url },
    request: { res: { responseUrl: url } },
    headers: { 'content-type': 'text/html' },
  }) as never;

const makeNsmItem = (): INsmBillItem =>
  ({
    billNo: '2219776',
    billName: '테스트 NSM 법률안',
    proposer: '홍길동의원',
    committee: '',
    ministry: '법무부',
    link: 'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219776/detailRP',
  }) as INsmBillItem;

/**
 * Drives the real ArchiveOrchestratorService against the real
 * NoticeArchiveService backed by SQLite, with the production immutability
 * trigger installed, so screenshot-failure recording is proven to persist
 * (or not) rather than only asserted against mocks.
 */
describe('ArchiveOrchestratorService inline screenshot failures (real persistence)', () => {
  let dataSource: DataSource;
  let noticeArchiveService: NoticeArchiveService;
  let service: ArchiveOrchestratorService;
  let crawlingCoreService: {
    getContent: jest.Mock;
    captureContentScreenshot: jest.Mock;
    captureNsmDetailFull: jest.Mock;
    probeNsmDeletedBillAlert: jest.Mock;
  };
  let loggerWarnSpy: jest.SpyInstance;

  const createChangeTrackingMock = () => ({
    getCompleteNoticeChangeTimeline: jest.fn().mockResolvedValue([]),
    buildDiffEvent: jest.fn().mockReturnValue({ shouldAppend: false }),
    beginChangeNotificationCollection: jest.fn(),
    endChangeNotificationCollection: jest.fn().mockResolvedValue(undefined),
    beginChangeNotificationSuppression: jest.fn(),
    endChangeNotificationSuppression: jest.fn(),
    flushQueuedChangeNotificationsNow: jest.fn().mockResolvedValue(undefined),
  });

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [
        NoticeArchive,
        NoticeArchiveSnapshotState,
        NoticeArchiveIntegrityCheck,
        NoticeArchiveIntegrityState,
      ],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    // Install the same immutability trigger production runs, so the
    // screenshot-status UPDATE is exercised against the real guard.
    const queryRunner = dataSource.createQueryRunner();
    await new AllowSnapshotArtifactFirstFill1755043201000().up(queryRunner);
    await queryRunner.release();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(NoticeArchive).clear();
    await dataSource.getRepository(NoticeArchiveSnapshotState).clear();
    await dataSource.getRepository(NoticeArchiveIntegrityCheck).clear();
    await dataSource.getRepository(NoticeArchiveIntegrityState).clear();

    noticeArchiveService = new NoticeArchiveService(
      dataSource.getRepository(NoticeArchive),
      dataSource.getRepository(NoticeArchiveSnapshotState),
      createChangeTrackingMock() as never,
      { logEvent: jest.fn() } as never,
      dataSource.getRepository(NoticeArchiveIntegrityCheck),
      dataSource.getRepository(NoticeArchiveIntegrityState),
    );

    crawlingCoreService = {
      getContent: jest.fn().mockResolvedValue({
        title: '법안 제목',
        proposalReason: '제안 이유',
        billNumber: 'B-001',
        proposer: '홍길동',
        proposalDate: '2026-01-01',
        committee: '법제사법위원회',
        referralDate: '2026-01-02',
        noticePeriod: '20일',
        proposalSession: '22대',
      }),
      captureContentScreenshot: jest.fn(),
      captureNsmDetailFull: jest.fn(),
      probeNsmDeletedBillAlert: jest.fn().mockResolvedValue(null),
    };

    service = new ArchiveOrchestratorService(
      {
        getObject: jest.fn().mockResolvedValue(null),
        setObject: jest.fn().mockResolvedValue(true),
        deleteKey: jest.fn().mockResolvedValue(true),
      } as never,
      noticeArchiveService,
      crawlingCoreService as never,
      { logEvent: jest.fn() } as never,
    );

    loggerWarnSpy = jest
      .spyOn(
        LoggerUtils.getContextLogger(ArchiveOrchestratorService.name),
        'warn',
      )
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('persists failed status + classified reason when PAL capture throws', async () => {
    const notice = makeNotice(1001);
    mockFetchHtmlPage.mockResolvedValue(makeHtmlResponse(notice.link));
    crawlingCoreService.captureContentScreenshot.mockRejectedValue(
      new Error('Failed to launch browser: no available lease'),
    );

    const saved = await service.archiveNotices([notice]);
    expect(saved).toBe(1);

    const row = await dataSource
      .getRepository(NoticeArchive)
      .findOneByOrFail({ noticeNum: notice.num });
    expect(row.sourceHtml).not.toBeNull();
    expect(row.screenshotBlob).toBeNull();
    expect(row.screenshotCaptureStatus).toBe('failed');
    expect(row.screenshotCaptureError).toContain('browser_error');
    expect(row.screenshotCaptureError).toContain(
      'Failed to launch browser: no available lease',
    );
    // The raw capture error must reach an operator, not just the DB row.
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Inline screenshot capture failed for notice 1001',
      ),
    );
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to launch browser: no available lease'),
    );

    const retryable =
      await noticeArchiveService.getNoticesWithMissingScreenshots(10);
    expect(retryable.map((item) => item.num)).toContain(notice.num);
  });

  it('persists failed status + size_limit reason when PAL capture returns null', async () => {
    const notice = makeNotice(1002);
    mockFetchHtmlPage.mockResolvedValue(makeHtmlResponse(notice.link));
    crawlingCoreService.captureContentScreenshot.mockResolvedValue(null);

    await service.archiveNotices([notice]);

    const row = await dataSource
      .getRepository(NoticeArchive)
      .findOneByOrFail({ noticeNum: notice.num });
    expect(row.screenshotBlob).toBeNull();
    expect(row.screenshotCaptureStatus).toBe('failed');
    expect(row.screenshotCaptureError).toContain('size_limit');
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Inline screenshot capture failed for notice 1002',
      ),
    );
  });

  it('stores the blob and leaves the row out of the retry set on success', async () => {
    const notice = makeNotice(1003);
    mockFetchHtmlPage.mockResolvedValue(makeHtmlResponse(notice.link));
    crawlingCoreService.captureContentScreenshot.mockResolvedValue(
      Buffer.from('jpeg-bytes'),
    );

    await service.archiveNotices([notice]);

    const row = await dataSource
      .getRepository(NoticeArchive)
      .findOneByOrFail({ noticeNum: notice.num });
    expect(row.screenshotBlob).not.toBeNull();
    expect(row.screenshotCaptureStatus).not.toBe('failed');

    const retryable =
      await noticeArchiveService.getNoticesWithMissingScreenshots(10);
    expect(retryable.map((item) => item.num)).not.toContain(notice.num);
  });

  it('does not overwrite the stored blob when an existing row is re-archived', async () => {
    const notice = makeNotice(1005);
    mockFetchHtmlPage.mockResolvedValue(makeHtmlResponse(notice.link));
    crawlingCoreService.captureContentScreenshot.mockResolvedValue(
      Buffer.from('first-jpeg'),
    );
    await service.archiveNotices([notice]);

    // Re-detected notice: the inline capture of the second run must not
    // overwrite the immutable first snapshot (the production trigger rejects
    // any non-null to non-null write of screenshot_blob).
    crawlingCoreService.captureContentScreenshot.mockResolvedValue(
      Buffer.from('second-jpeg'),
    );
    const saved = await service.archiveNotices([notice]);

    expect(saved).toBe(1);
    const row = await dataSource
      .getRepository(NoticeArchive)
      .findOneByOrFail({ noticeNum: notice.num });
    expect((row.screenshotBlob as Buffer).toString()).toBe('first-jpeg');
  });

  it('records the same failed state for the NSM inline path', async () => {
    crawlingCoreService.captureNsmDetailFull.mockRejectedValue(
      new Error('Failed to launch browser: no available lease'),
    );

    await service.archiveNsmBillItems([makeNsmItem()]);

    const row = await dataSource
      .getRepository(NoticeArchive)
      .findOneByOrFail({ noticeNum: 2219776 });
    expect(row.screenshotBlob).toBeNull();
    expect(row.screenshotCaptureStatus).toBe('failed');
    expect(row.screenshotCaptureError).toContain('browser_error');
    expect(row.screenshotCaptureError).toContain(
      'Failed to launch browser: no available lease',
    );

    const retryable =
      await noticeArchiveService.getNoticesWithMissingNsmScreenshots(10);
    expect(retryable.map((item) => item.num)).toContain(2219776);
  });

  it('records the failure for a real browser-lease-layer error', async () => {
    const notice = makeNotice(1004);
    mockFetchHtmlPage.mockResolvedValue(makeHtmlResponse(notice.link));
    // Exact message thrown by BrowserLeaseManagerService.runWithLease when a
    // lease cannot be granted because the manager is shutting down.
    crawlingCoreService.captureContentScreenshot.mockRejectedValue(
      new Error(
        'captureContentScreenshot(content-1004, fullPage=true): browser lease manager is shutting down',
      ),
    );

    await service.archiveNotices([notice]);

    const row = await dataSource
      .getRepository(NoticeArchive)
      .findOneByOrFail({ noticeNum: notice.num });
    expect(row.screenshotBlob).toBeNull();
    expect(row.screenshotCaptureStatus).toBe('failed');
    expect(row.screenshotCaptureError).toContain(
      'browser lease manager is shutting down',
    );
  });
});
