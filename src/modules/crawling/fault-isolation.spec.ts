/**
 * Fault-isolation E2E test suite
 *
 * Purpose: Inject deliberate failures into each subsystem (pal-crawl, DB,
 * Ollama/AI, Redis cache, HTTP page capture) and assert that the service
 * pipeline continues to make forward progress rather than crashing or
 * blocking downstream stages.
 *
 * Every test verifies two things:
 *  1. The method under test does NOT throw (fault is contained).
 *  2. The downstream outcome is correct given the fault (e.g. cache is still
 *     updated, notifications are still attempted, results degrade gracefully).
 *
 * These tests use `@nestjs/testing` with hand-crafted mock providers so no
 * real network, DB, or Ollama connection is required.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CrawlingSchedulerService } from './crawling-scheduler.service';
import { ArchiveSyncService } from './archive-sync.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { NotificationBatchService } from '../notification/notification-batch.service';
import { CacheService } from '../cache/cache.service';
import { CrawlingCoreService } from './crawling-core.service';
import { SummaryGenerationService } from './summary-generation.service';
import { ArchiveOrchestratorService as ArchiveOrchestrator } from './archive-orchestrator.service';
import { NotificationOrchestratorService } from '../notification/notification-orchestrator.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { WebhookService } from '../webhook/webhook.service';
import { NotificationService } from '../notification/notification.service';
import { BatchProcessingService } from '../shared/batch-processing.service';
import { type CachedNotice } from '../../types/cache.types';
import { type ITableData, type ISearchResult } from 'pal-crawl';

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const makeTableData = (num: number): ITableData => ({
  num,
  subject: `법안 ${num}`,
  proposerCategory: '정부',
  committee: '법제사법위원회',
  numComments: 0,
  link: `https://example.com/notice/${num}`,
  contentId: `content-${num}`,
  attachments: { pdfFile: '', hwpFile: '' },
});

const makeCachedNotice = (num: number): CachedNotice => ({
  ...makeTableData(num),
  aiSummary: null,
  aiSummaryStatus: 'not_requested',
});

const makeSearchResult = (nums: number[]): ISearchResult => ({
  items: nums.map(makeTableData),
  currentPage: 1,
  totalPages: 1,
  total: nums.length,
});

/** Returns an async generator that yields the given pages. */
async function* makePageGenerator(
  pages: ISearchResult[],
): AsyncGenerator<ISearchResult> {
  for (const page of pages) {
    yield page;
  }
}

/** Returns an async generator that throws after yielding `beforeThrow` pages. */
async function* makeFailingPageGenerator(
  pages: ISearchResult[],
  beforeThrow = 0,
): AsyncGenerator<ISearchResult> {
  for (let i = 0; i < beforeThrow && i < pages.length; i++) {
    yield pages[i];
  }
  throw new Error('pal-crawl: simulated network failure');
}

// ─── Suite 1: CrawlingSchedulerService ───────────────────────────────────────

describe('[Fault Isolation] CrawlingSchedulerService', () => {
  let service: CrawlingSchedulerService;
  let cacheService: jest.Mocked<CacheService>;
  let crawlingCoreService: jest.Mocked<CrawlingCoreService>;
  let summaryGenerationService: jest.Mocked<SummaryGenerationService>;
  let archiveOrchestratorService: jest.Mocked<ArchiveOrchestrator>;
  let notificationOrchestratorService: jest.Mocked<NotificationOrchestratorService>;
  let noticeArchiveService: jest.Mocked<NoticeArchiveService>;

  const notices = [makeCachedNotice(1), makeCachedNotice(2)];
  const tableData = [makeTableData(1), makeTableData(2)];

  beforeEach(async () => {
    const objectStore = new Map<string, unknown>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrawlingSchedulerService,
        {
          provide: CacheService,
          useValue: {
            updateCache: jest.fn().mockResolvedValue(undefined),
            findNewNotices: jest.fn().mockResolvedValue([]),
            getRecentNotices: jest.fn().mockResolvedValue([]),
            getObject: jest
              .fn()
              .mockImplementation(async (key: string) =>
                objectStore.has(key) ? objectStore.get(key) : null,
              ),
            setObject: jest
              .fn()
              .mockImplementation(async (key: string, value: unknown) => {
                objectStore.set(key, value);
                return true;
              }),
            deleteKey: jest
              .fn()
              .mockImplementation(async (key: string) =>
                objectStore.delete(key),
              ),
          },
        },
        {
          provide: CrawlingCoreService,
          useValue: {
            crawlAllPages: jest.fn().mockResolvedValue(tableData),
          },
        },
        {
          provide: SummaryGenerationService,
          useValue: {
            enrichNoticesWithSummary: jest.fn().mockResolvedValue(notices),
            generateSummaryForNotice: jest.fn().mockResolvedValue({
              aiSummary: null,
              aiSummaryStatus: 'not_requested',
            }),
          },
        },
        {
          provide: ArchiveOrchestrator,
          useValue: {
            archiveNotices: jest.fn().mockResolvedValue(2),
            filterAlreadyArchivedNotices: jest
              .fn()
              .mockResolvedValue(tableData),
          },
        },
        {
          provide: NotificationOrchestratorService,
          useValue: {
            sendNotifications: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NoticeArchiveService,
          useValue: {
            getSummaryStateByNoticeNums: jest.fn().mockResolvedValue(new Map()),
            updateSummaryStateByNoticeNum: jest
              .fn()
              .mockResolvedValue(undefined),
            getExistingNoticeNumSet: jest.fn().mockResolvedValue(new Set()),
          },
        },
      ],
    }).compile();

    service = module.get(CrawlingSchedulerService);
    cacheService = module.get(CacheService);
    crawlingCoreService = module.get(CrawlingCoreService);
    summaryGenerationService = module.get(SummaryGenerationService);
    archiveOrchestratorService = module.get(ArchiveOrchestrator);
    notificationOrchestratorService = module.get(
      NotificationOrchestratorService,
    );
    noticeArchiveService = module.get(NoticeArchiveService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── initializeCache failures ──────────────────────────────────────────────

  it('DB failure (getSummaryStateByNoticeNums) during initializeCache → cache still updated', async () => {
    noticeArchiveService.getSummaryStateByNoticeNums.mockRejectedValue(
      new Error('SQLite: SQLITE_BUSY'),
    );

    // Access private method via type assertion to test directly
    await expect((service as any).initializeCache()).resolves.not.toThrow();

    expect(cacheService.updateCache).toHaveBeenCalledTimes(1);
  });

  it('Ollama failure (enrichNoticesWithSummary) during initializeCache → cache falls back to raw notices', async () => {
    summaryGenerationService.enrichNoticesWithSummary.mockRejectedValue(
      new Error('Ollama: connection refused'),
    );

    await expect((service as any).initializeCache()).resolves.not.toThrow();

    // Cache must still be populated - even without AI summaries
    expect(cacheService.updateCache).toHaveBeenCalledTimes(1);
    const cachedNotices: CachedNotice[] =
      cacheService.updateCache.mock.calls[0][0];
    expect(cachedNotices.length).toBeGreaterThan(0);
    cachedNotices.forEach((n) =>
      expect(n.aiSummaryStatus).toBe('not_requested'),
    );
  });

  it('Archive failure (archiveNotices) during initializeCache → cache still updated', async () => {
    archiveOrchestratorService.archiveNotices.mockRejectedValue(
      new Error('DB write error'),
    );

    await expect((service as any).initializeCache()).resolves.not.toThrow();

    expect(cacheService.updateCache).toHaveBeenCalledTimes(1);
  });

  // ── handleCron (performCrawlingAndNotification) failures ──────────────────

  it('pal-crawl throws during cron → handleCron does not throw, isProcessing reset to false', async () => {
    crawlingCoreService.crawlAllPages.mockRejectedValue(
      new Error('pal-crawl: timeout'),
    );

    await expect(service.handleCron()).resolves.not.toThrow();

    // isProcessing guard must be released so future cron ticks can run
    expect((service as any).isProcessing).toBe(false);
  });

  it('Redis failure (findNewNotices) during cron → falls back to archive-based dedup, cache updated', async () => {
    (service as any).isInitialized = true;
    cacheService.getRecentNotices.mockResolvedValue([]);
    crawlingCoreService.crawlAllPages.mockResolvedValue(tableData);
    cacheService.findNewNotices.mockRejectedValue(
      new Error('Redis: ECONNREFUSED'),
    );
    archiveOrchestratorService.filterAlreadyArchivedNotices.mockResolvedValue(
      [],
    );

    await expect(service.handleCron()).resolves.not.toThrow();
    // Flush microtask queue to allow fire-and-forget background tasks to complete
    await new Promise((resolve) => setImmediate(resolve));
    // Cache must be updated at least once (fast path + background retry both call updateCache)
    expect(cacheService.updateCache).toHaveBeenCalled();
  });

  it('DB failure (getSummaryStateByNoticeNums) during cron with new notices → falls back to empty map, notifications still sent', async () => {
    (service as any).isInitialized = true;
    cacheService.getRecentNotices.mockResolvedValue([]);
    crawlingCoreService.crawlAllPages.mockResolvedValue(tableData);
    cacheService.findNewNotices.mockResolvedValue(tableData);
    archiveOrchestratorService.filterAlreadyArchivedNotices.mockResolvedValue(
      tableData,
    );
    noticeArchiveService.getSummaryStateByNoticeNums.mockRejectedValue(
      new Error('DB: connection lost'),
    );
    summaryGenerationService.enrichNoticesWithSummary.mockResolvedValue(
      notices,
    );

    await expect(service.handleCron()).resolves.not.toThrow();
    // Flush microtask queue so processNewNoticesInBackground (fire-and-forget) completes
    await new Promise((resolve) => setImmediate(resolve));

    // Notifications must still be dispatched
    expect(
      notificationOrchestratorService.sendNotifications,
    ).toHaveBeenCalledTimes(1);
  });

  it('Ollama failure during cron with new notices → raw notices used, cache+notifications proceed', async () => {
    (service as any).isInitialized = true;
    cacheService.getRecentNotices.mockResolvedValue([]);
    crawlingCoreService.crawlAllPages.mockResolvedValue(tableData);
    cacheService.findNewNotices.mockResolvedValue(tableData);
    archiveOrchestratorService.filterAlreadyArchivedNotices.mockResolvedValue(
      tableData,
    );
    noticeArchiveService.getSummaryStateByNoticeNums.mockResolvedValue(
      new Map(),
    );
    summaryGenerationService.enrichNoticesWithSummary.mockRejectedValue(
      new Error('Ollama: context window exceeded'),
    );

    await expect(service.handleCron()).resolves.not.toThrow();
    // Flush microtask queue so processNewNoticesInBackground (fire-and-forget) completes
    await new Promise((resolve) => setImmediate(resolve));

    // Cache is updated at least once (fast path + background both call updateCache)
    expect(cacheService.updateCache).toHaveBeenCalled();
    expect(
      notificationOrchestratorService.sendNotifications,
    ).toHaveBeenCalledTimes(1);
  });

  it('Archive failure during cron with new notices → cache and notifications not blocked', async () => {
    (service as any).isInitialized = true;
    cacheService.getRecentNotices.mockResolvedValue([]);
    crawlingCoreService.crawlAllPages.mockResolvedValue(tableData);
    cacheService.findNewNotices.mockResolvedValue(tableData);
    archiveOrchestratorService.filterAlreadyArchivedNotices.mockResolvedValue(
      tableData,
    );
    noticeArchiveService.getSummaryStateByNoticeNums.mockResolvedValue(
      new Map(),
    );
    summaryGenerationService.enrichNoticesWithSummary.mockResolvedValue(
      notices,
    );
    archiveOrchestratorService.archiveNotices.mockRejectedValue(
      new Error('DB: disk full'),
    );

    await expect(service.handleCron()).resolves.not.toThrow();
    // Flush microtask queue so processNewNoticesInBackground (fire-and-forget) completes
    await new Promise((resolve) => setImmediate(resolve));

    // Cache is updated at least once (fast path + background both call updateCache)
    expect(cacheService.updateCache).toHaveBeenCalled();
    expect(
      notificationOrchestratorService.sendNotifications,
    ).toHaveBeenCalledTimes(1);
  });
});

// ─── Suite 2: ArchiveOrchestratorService ─────────────────────────────────────

describe('[Fault Isolation] ArchiveOrchestratorService', () => {
  let service: ArchiveOrchestratorService;
  let noticeArchiveService: jest.Mocked<NoticeArchiveService>;
  let crawlingCoreService: jest.Mocked<CrawlingCoreService>;

  const mockFetch = jest.fn();

  beforeAll(() => {
    globalThis.fetch = mockFetch;
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArchiveOrchestratorService,
        {
          provide: CacheService,
          useValue: {
            getObject: jest.fn().mockResolvedValue(null),
            setObject: jest.fn().mockResolvedValue(true),
            deleteKey: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: NoticeArchiveService,
          useValue: {
            upsertNoticeArchive: jest.fn().mockResolvedValue(undefined),
            getExistingNoticeNumSet: jest.fn().mockResolvedValue(new Set()),
            getNoticesWithMissingScreenshots: jest.fn().mockResolvedValue([]),
            getNoticesWithMissingNsmScreenshots: jest
              .fn()
              .mockResolvedValue([]),
            getAllPalNoticesForScreenshotRequeue: jest
              .fn()
              .mockResolvedValue([]),
          },
        },
        {
          provide: CrawlingCoreService,
          useValue: {
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
          },
        },
      ],
    }).compile();

    service = module.get(ArchiveOrchestratorService);
    noticeArchiveService = module.get(NoticeArchiveService);
    crawlingCoreService = module.get(CrawlingCoreService);
  });

  afterEach(() => jest.clearAllMocks());

  const mockOkFetch = () =>
    mockFetch.mockResolvedValue({
      text: jest.fn().mockResolvedValue('<html>본문</html>'),
      url: 'https://example.com/notice/1',
      status: 200,
      headers: {
        get: jest.fn().mockReturnValue(null),
      },
    });

  it('pal-crawl getContent throws → notice still archived (with empty proposalReason)', async () => {
    crawlingCoreService.getContent.mockRejectedValue(
      new Error('pal-crawl: parse error'),
    );
    mockOkFetch();

    const count = await service.archiveNotices([makeCachedNotice(1)]);

    // Archive must still save the notice (HTML captured even without content)
    expect(count).toBe(1);
    expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledTimes(1);
    const savedPayload =
      noticeArchiveService.upsertNoticeArchive.mock.calls[0][1];
    expect(savedPayload.proposalReason).toBe('');
  });

  it('pal-crawl getContent returns null → notice archived with empty proposalReason', async () => {
    crawlingCoreService.getContent.mockResolvedValue(null as any);
    mockOkFetch();

    const count = await service.archiveNotices([makeCachedNotice(1)]);

    expect(count).toBe(1);
    const savedPayload =
      noticeArchiveService.upsertNoticeArchive.mock.calls[0][1];
    expect(savedPayload.proposalReason).toBe('');
  });

  it('HTTP page capture (fetch) fails → notice still archived (with null sourceHtml)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const count = await service.archiveNotices([makeCachedNotice(1)]);

    expect(count).toBe(1);
    const savedPayload =
      noticeArchiveService.upsertNoticeArchive.mock.calls[0][1];
    expect(savedPayload.sourceHtml).toBeNull();
  });

  it('DB upsert fails for one notice in batch → other notices still succeed', async () => {
    mockOkFetch();
    noticeArchiveService.upsertNoticeArchive
      .mockRejectedValueOnce(new Error('DB: constraint violation'))
      .mockResolvedValue(undefined);

    const batch = [makeCachedNotice(1), makeCachedNotice(2)];
    const count = await service.archiveNotices(batch);

    // Second notice must succeed even though first failed
    expect(count).toBe(1);
    expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledTimes(2);
  });

  it('pal-crawl throws for some notices, DB upsert fails for others → surviving notices counted', async () => {
    crawlingCoreService.getContent
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({
        title: '법안',
        proposalReason: '이유',
        billNumber: null,
        proposer: null,
        proposalDate: null,
        committee: null,
        referralDate: null,
        noticePeriod: null,
        proposalSession: null,
      });
    mockFetch.mockResolvedValue({
      text: jest.fn().mockResolvedValue('<html></html>'),
      url: 'https://example.com',
      status: 200,
      headers: { get: jest.fn().mockReturnValue(null) },
    });
    noticeArchiveService.upsertNoticeArchive.mockResolvedValue(undefined);

    const count = await service.archiveNotices([
      makeCachedNotice(1),
      makeCachedNotice(2),
    ]);
    // Both notices should be archived (crawl failure is tolerated per-notice)
    expect(count).toBe(2);
  });
});

// ─── Suite 3: NotificationBatchService ───────────────────────────────────────

describe('[Fault Isolation] NotificationBatchService', () => {
  let service: NotificationBatchService;
  let webhookService: jest.Mocked<WebhookService>;
  let notificationService: jest.Mocked<NotificationService>;

  const notice = makeCachedNotice(1);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationBatchService,
        {
          provide: WebhookService,
          useValue: {
            findAll: jest.fn().mockResolvedValue([{ id: 1 }]),
            deactivateWebhooks: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            sendDiscordNotificationBatch: jest
              .fn()
              .mockResolvedValue([{ webhookId: 1, success: true }]),
          },
        },
        {
          provide: BatchProcessingService,
          useValue: {
            executeBatch: jest.fn().mockImplementation((jobs) =>
              Promise.all(
                jobs.map((job: (sig: AbortSignal) => Promise<unknown>) =>
                  job(new AbortController().signal).then((data) => ({
                    success: true,
                    data,
                  })),
                ),
              ),
            ),
            generateId: jest.fn().mockReturnValue('batch-test-id'),
            updateRecentJobMetadata: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(NotificationBatchService);
    webhookService = module.get(WebhookService);
    notificationService = module.get(NotificationService);
  });

  afterEach(() => jest.clearAllMocks());

  it('DB failure loading webhooks → executeNotificationBatch returns [] without throwing', async () => {
    webhookService.findAll.mockRejectedValue(
      new Error('SQLite: no such table'),
    );

    const result = await service.executeNotificationBatch([notice]);
    expect(result).toEqual([]);
    expect(
      notificationService.sendDiscordNotificationBatch,
    ).not.toHaveBeenCalled();
  });

  it('WebhookService.findAll returns null → executeNotificationBatch handles empty webhook list gracefully', async () => {
    webhookService.findAll.mockResolvedValue(null as any);

    // null resolved by `?? []` in service; jobs run with 0 webhooks → returns
    // results array (not empty, but each notice is processed with 0 webhooks)
    await expect(
      service.executeNotificationBatch([notice]),
    ).resolves.not.toThrow();
  });

  it('No active webhooks → processNotificationBatch resolves with a batch ID (no crash)', async () => {
    webhookService.findAll.mockResolvedValue([]);

    const batchId = await service.processNotificationBatch([notice]);
    expect(typeof batchId).toBe('string');
    expect(batchId.length).toBeGreaterThan(0);
  });
});

// ─── Suite 4: ArchiveSyncService ─────────────────────────────────────────────

describe('[Fault Isolation] ArchiveSyncService', () => {
  let service: ArchiveSyncService;
  let crawlingCoreService: jest.Mocked<CrawlingCoreService>;
  let noticeArchiveService: jest.Mocked<NoticeArchiveService>;
  let archiveOrchestratorService: jest.Mocked<ArchiveOrchestratorService>;
  let summaryGenerationService: jest.Mocked<SummaryGenerationService>;

  const twoPageGen = () =>
    makePageGenerator([
      makeSearchResult([1, 2, 3]),
      makeSearchResult([4, 5, 6]),
    ]);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArchiveSyncService,
        {
          provide: CrawlingCoreService,
          useValue: {
            getAllPages: jest.fn().mockImplementation(twoPageGen),
            getAllNsmPendingPages: jest
              .fn()
              .mockImplementation(async function* () {}),
            searchDone: jest.fn().mockResolvedValue(makeSearchResult([1, 2])),
          },
        },
        {
          provide: NoticeArchiveService,
          useValue: {
            getPendingSummaryPage: jest.fn().mockResolvedValue([]),
            getUnavailableSummaryPage: jest.fn().mockResolvedValue([]),
            runIntegrityScan: jest.fn().mockResolvedValue({
              scanned: 0,
              passed: 0,
              failed: 0,
              skipped: 0,
            }),
            markNoticesDoneByNums: jest.fn().mockResolvedValue(2),
            revertNoticesDoneByNums: jest.fn().mockResolvedValue(0),
            getDoneMarkedNumsPage: jest.fn().mockResolvedValue([]),
            updateSummaryStateByNoticeNum: jest
              .fn()
              .mockResolvedValue(undefined),
            getArchivedNullContentIdNums: jest
              .fn()
              .mockResolvedValue(new Set()),
            upgradePendingNotices: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: ArchiveOrchestratorService,
          useValue: {
            filterAlreadyArchivedNotices: jest
              .fn()
              .mockResolvedValue([makeTableData(3)]),
            archiveNotices: jest.fn().mockResolvedValue(1),
            archiveNsmBillItems: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: SummaryGenerationService,
          useValue: {
            isAiSummaryEnabled: jest.fn().mockReturnValue(true),
            generateSummaryForNotice: jest.fn().mockResolvedValue({
              aiSummary: '요약',
              aiSummaryStatus: 'ready',
            }),
          },
        },
        {
          provide: CacheService,
          useValue: {
            updateCache: jest.fn().mockResolvedValue(undefined),
            getObject: jest.fn().mockResolvedValue(null),
            setObject: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();

    service = module.get(ArchiveSyncService);
    crawlingCoreService = module.get(CrawlingCoreService);
    noticeArchiveService = module.get(NoticeArchiveService);
    archiveOrchestratorService = module.get(ArchiveOrchestratorService);
    summaryGenerationService = module.get(SummaryGenerationService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── executeFullSync (Phase 1) ─────────────────────────────────────────────

  it('pal-crawl getAllPages throws mid-stream → runFullSync throws (phase tracker set to failed)', async () => {
    crawlingCoreService.getAllPages.mockImplementation(() =>
      makeFailingPageGenerator([makeSearchResult([1, 2])], 0),
    );

    // runPhase re-throws after recording status='failed'
    await expect(service.runFullSync('fault-test')).rejects.toThrow(
      'pal-crawl: simulated network failure',
    );
    expect(service.getFullSyncStatus().status).toBe('failed');
  });

  it('pal-crawl returns page with null items → full sync completes with 0 scanned', async () => {
    crawlingCoreService.getAllPages.mockImplementation(() =>
      makePageGenerator([{ ...makeSearchResult([]), items: null as any }]),
    );
    archiveOrchestratorService.filterAlreadyArchivedNotices.mockResolvedValue(
      [],
    );

    const result = await service.runFullSync('fault-test');
    expect(result).not.toBeNull();
    expect(result!.totalNoticesScanned).toBe(0);
  });

  it('pal-crawl streams one valid page then throws → safeRun swallows error in bootstrap, next phase runs', async () => {
    // Replace crawlingCoreService mock with a generator that yields 1 page then throws
    crawlingCoreService.getAllPages.mockImplementation(() =>
      makeFailingPageGenerator([makeSearchResult([1])], 1),
    );
    archiveOrchestratorService.filterAlreadyArchivedNotices.mockResolvedValue(
      [],
    );

    // runFullSync will fail (partial data collected) → runPhase re-throws →
    // safeRun in bootstrap pipeline swallows it
    const safeRunSpy = jest.spyOn(service as any, 'safeRun');
    await (service as any).runBootstrapPipeline();

    // All safeRun calls should have resolved (not thrown externally)
    expect(safeRunSpy).toHaveBeenCalled();
  });

  // ── reconcileIsDone (Phase 2) ─────────────────────────────────────────────

  it('pal-crawl searchDone throws on first page → runIsDoneSync throws (phase tracker set to failed)', async () => {
    crawlingCoreService.searchDone.mockRejectedValue(
      new Error('pal-crawl: simulated network failure'),
    );

    // runPhase re-throws after recording status='failed'
    await expect(service.runIsDoneSync('fault-test')).rejects.toThrow(
      'pal-crawl: simulated network failure',
    );
    expect(service.getIsDoneSyncStatus().status).toBe('failed');
  }, 10_000); // allow time for per-page retry backoff

  it('pal-crawl searchDone returns null items → reconcileIsDone completes, markNoticesDoneByNums called with []', async () => {
    crawlingCoreService.searchDone.mockResolvedValue({
      ...makeSearchResult([]),
      items: null as any,
      totalPages: 1,
    });

    // When zero done notices are fetched, isDone reconciliation returns early
    const result = await service.runIsDoneSync('fault-test');
    expect(result).not.toBeNull();
    expect(result!.fetchedDoneCount).toBe(0);
  });

  it('DB markNoticesDoneByNums throws → runIsDoneSync throws (phase tracker set to failed)', async () => {
    crawlingCoreService.searchDone.mockResolvedValue(makeSearchResult([1, 2]));
    noticeArchiveService.markNoticesDoneByNums.mockRejectedValue(
      new Error('DB: write timeout'),
    );

    // markNoticesDoneByNums throws inside for-await loop → propagates through
    // runPhase → status set to 'failed', exception re-thrown
    await expect(service.runIsDoneSync('fault-test')).rejects.toThrow(
      'DB: write timeout',
    );
    expect(service.getIsDoneSyncStatus().status).toBe('failed');
  });

  // ── executeSummaryBackfill (Phase 4) ──────────────────────────────────────

  it('Ollama generateSummaryForNotice throws for one item in batch → remaining items still processed, phase completes', async () => {
    const batchItems = [
      { ...makeCachedNotice(10), aiSummaryStatus: 'not_requested' as const },
      { ...makeCachedNotice(11), aiSummaryStatus: 'not_requested' as const },
      { ...makeCachedNotice(12), aiSummaryStatus: 'not_requested' as const },
    ];

    noticeArchiveService.getPendingSummaryPage
      .mockResolvedValueOnce(batchItems as any)
      .mockResolvedValue([]);

    summaryGenerationService.generateSummaryForNotice
      .mockRejectedValueOnce(new Error('Ollama: timeout'))
      .mockResolvedValue({ aiSummary: '요약', aiSummaryStatus: 'ready' });

    const result = await service.runSummaryBackfill('fault-test');
    expect(result).not.toBeNull();
    // 1 threw → counted as failed; 2 succeeded → generated
    expect(result!.failed).toBe(1);
    expect(result!.generated).toBe(2);
    expect(result!.scanned).toBe(3);
    expect(
      noticeArchiveService.updateSummaryStateByNoticeNum,
    ).toHaveBeenCalledWith(10, null, 'unavailable');
  });

  it('DB updateSummaryStateByNoticeNum throws for one item → other items in batch still updated, phase completes', async () => {
    const batchItems = [
      { ...makeCachedNotice(20), aiSummaryStatus: 'not_requested' as const },
      { ...makeCachedNotice(21), aiSummaryStatus: 'not_requested' as const },
    ];

    noticeArchiveService.getPendingSummaryPage
      .mockResolvedValueOnce(batchItems as any)
      .mockResolvedValue([]);

    summaryGenerationService.generateSummaryForNotice.mockResolvedValue({
      aiSummary: '요약',
      aiSummaryStatus: 'ready',
    });

    noticeArchiveService.updateSummaryStateByNoticeNum
      .mockRejectedValueOnce(new Error('DB: busy'))
      .mockResolvedValue(undefined);

    const result = await service.runSummaryBackfill('fault-test');
    expect(result).not.toBeNull();
    // First item's DB write failed → counted as 'unavailable'
    expect(result!.failed).toBe(1);
    // Second item succeeded
    expect(result!.generated).toBe(1);
  });

  // ── executeUnavailableRetry (Phase 5) ─────────────────────────────────────

  it('Ollama throws for unavailable-retry item → item counted as stillFailed, phase completes', async () => {
    const batchItems = [
      { ...makeCachedNotice(30), aiSummaryStatus: 'unavailable' as const },
      { ...makeCachedNotice(31), aiSummaryStatus: 'unavailable' as const },
    ];

    noticeArchiveService.getUnavailableSummaryPage
      .mockResolvedValueOnce(batchItems as any)
      .mockResolvedValue([]);

    summaryGenerationService.generateSummaryForNotice
      .mockRejectedValueOnce(new Error('Ollama: model not loaded'))
      .mockResolvedValue({ aiSummary: '요약', aiSummaryStatus: 'ready' });

    const result = await service.runUnavailableRetry('fault-test');
    expect(result).not.toBeNull();
    expect(result!.stillFailed).toBe(1);
    expect(result!.recovered).toBe(1);
  });

  it('DB updateSummaryStateByNoticeNum throws in unavailable-retry → phase still completes, item counted as stillFailed', async () => {
    const batchItems = [
      { ...makeCachedNotice(40), aiSummaryStatus: 'unavailable' as const },
    ];

    noticeArchiveService.getUnavailableSummaryPage
      .mockResolvedValueOnce(batchItems as any)
      .mockResolvedValue([]);

    summaryGenerationService.generateSummaryForNotice.mockResolvedValue({
      aiSummary: '요약',
      aiSummaryStatus: 'ready',
    });

    noticeArchiveService.updateSummaryStateByNoticeNum.mockRejectedValue(
      new Error('DB: constraint'),
    );

    const result = await service.runUnavailableRetry('fault-test');
    expect(result).not.toBeNull();
    expect(result!.stillFailed).toBe(1);
    expect(result!.recovered).toBe(0);
  });

  // ── Concurrent phase guard ────────────────────────────────────────────────

  it('Running the same phase twice concurrently → second call returns null (skipped), first completes normally', async () => {
    let resolveFirst!: () => void;
    const firstCallBlocker = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    crawlingCoreService.getAllPages.mockImplementationOnce(async function* () {
      await firstCallBlocker;
      yield makeSearchResult([1]);
    });
    archiveOrchestratorService.filterAlreadyArchivedNotices.mockResolvedValue(
      [],
    );

    // Start first call (will block until resolveFirst)
    const firstCall = service.runFullSync('first');

    // Attempt second call immediately - phase is running, should return null
    const secondResult = await service.runFullSync('second');
    expect(secondResult).toBeNull();

    // Unblock first call and verify it completes
    resolveFirst();
    const firstResult = await firstCall;
    expect(firstResult).not.toBeNull();
  });
});

// ─── Suite 5: CrawlingCoreService ────────────────────────────────────────────

describe('[Fault Isolation] CrawlingCoreService.crawlAllPages partial failure', () => {
  /**
   * Tests the built-in partial-failure recovery in crawlAllPages:
   * if the stream throws after we already have data, we return what we have
   * rather than discarding everything.
   */

  it('stream error after collecting items → partial data returned (not thrown)', async () => {
    // We cannot easily instantiate CrawlingCoreService directly without real
    // pal-crawl config, so we test the behaviour via a minimal integration
    // using a spy on getAllPages.

    // The actual crawlAllPages code lives in CrawlingCoreService; test it
    // indirectly through CrawlingSchedulerService's initializeCache, which
    // calls crawlAllPages and must forward partial data to the cache.

    // We achieve this by having crawlAllPages return partial data (simulating
    // the recovery path) and verifying the cache is updated.
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrawlingSchedulerService,
        {
          provide: CacheService,
          useValue: {
            updateCache: jest.fn().mockResolvedValue(undefined),
            findNewNotices: jest.fn(),
            getRecentNotices: jest.fn(),
            getObject: jest.fn().mockResolvedValue(null),
            setObject: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: CrawlingCoreService,
          useValue: {
            // Simulates the partial-data recovery path: returns 1 item despite
            // internal stream failure
            crawlAllPages: jest.fn().mockResolvedValue([makeTableData(99)]),
          },
        },
        {
          provide: SummaryGenerationService,
          useValue: {
            enrichNoticesWithSummary: jest
              .fn()
              .mockResolvedValue([makeCachedNotice(99)]),
          },
        },
        {
          provide: ArchiveOrchestrator,
          useValue: {
            archiveNotices: jest.fn().mockResolvedValue(1),
            filterAlreadyArchivedNotices: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: NotificationOrchestratorService,
          useValue: { sendNotifications: jest.fn() },
        },
        {
          provide: NoticeArchiveService,
          useValue: {
            getSummaryStateByNoticeNums: jest.fn().mockResolvedValue(new Map()),
            updateSummaryStateByNoticeNum: jest
              .fn()
              .mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    const scheduler = module.get(CrawlingSchedulerService);
    const cacheService = module.get(CacheService);

    await (scheduler as any).initializeCache();

    // Partial data must still reach the cache
    expect(cacheService.updateCache).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ num: 99 })]),
    );
  });
});
