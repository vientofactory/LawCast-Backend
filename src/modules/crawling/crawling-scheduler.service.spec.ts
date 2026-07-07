import { Test, TestingModule } from '@nestjs/testing';
import { CrawlingSchedulerService } from './crawling-scheduler.service';
import { CacheService } from '../cache/cache.service';
import { CrawlingCoreService } from './crawling-core.service';
import { SummaryGenerationService } from './summary-generation.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { NotificationOrchestratorService } from '../notification/notification-orchestrator.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import { APP_CONSTANTS } from '../../config/app.config';
import { type ITableData } from 'pal-crawl';

describe('CrawlingSchedulerService', () => {
  let service: CrawlingSchedulerService;
  let cacheService: CacheService;
  let crawlingCoreService: CrawlingCoreService;
  let summaryGenerationService: SummaryGenerationService;
  let archiveOrchestratorService: ArchiveOrchestratorService;
  let notificationOrchestratorService: NotificationOrchestratorService;
  let noticeArchiveService: NoticeArchiveService;

  const mockTableData: ITableData[] = [
    {
      num: 1,
      subject: '테스트 입법예고 1',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      numComments: 5,
      link: '/test/link/1',
      contentId: 'content-1',
      attachments: { pdfFile: '', hwpFile: '' },
    },
    {
      num: 2,
      subject: '테스트 입법예고 2',
      proposerCategory: '의원',
      committee: '국정감사위원회',
      numComments: 3,
      link: '/test/link/2',
      contentId: 'content-2',
      attachments: { pdfFile: '', hwpFile: '' },
    },
  ];

  beforeEach(async () => {
    const objectStore = new Map<string, unknown>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrawlingSchedulerService,
        {
          provide: CacheService,
          useValue: {
            updateCache: jest.fn(),
            findNewNotices: jest.fn(),
            getRecentNotices: jest.fn(),
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
            crawlAllPages: jest.fn(),
            getAllNsmPendingPages: jest.fn(),
          },
        },
        {
          provide: SummaryGenerationService,
          useValue: {
            enrichNoticesWithSummary: jest.fn(),
            generateSummaryForNotice: jest.fn(),
          },
        },
        {
          provide: ArchiveOrchestratorService,
          useValue: {
            archiveNotices: jest.fn(),
            filterAlreadyArchivedNotices: jest.fn(),
          },
        },
        {
          provide: NotificationOrchestratorService,
          useValue: {
            sendNotifications: jest.fn(),
          },
        },
        {
          provide: NoticeArchiveService,
          useValue: {
            getSummaryStateByNoticeNums: jest.fn(),
            updateSummaryStateByNoticeNum: jest.fn(),
            getExistingNoticeNumSet: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CrawlingSchedulerService>(CrawlingSchedulerService);
    cacheService = module.get<CacheService>(CacheService);
    crawlingCoreService = module.get<CrawlingCoreService>(CrawlingCoreService);
    summaryGenerationService = module.get<SummaryGenerationService>(
      SummaryGenerationService,
    );
    archiveOrchestratorService = module.get<ArchiveOrchestratorService>(
      ArchiveOrchestratorService,
    );
    notificationOrchestratorService =
      module.get<NotificationOrchestratorService>(
        NotificationOrchestratorService,
      );
    noticeArchiveService =
      module.get<NoticeArchiveService>(NoticeArchiveService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should initialize cache in background', async () => {
      (crawlingCoreService.crawlAllPages as jest.Mock).mockResolvedValue(
        mockTableData,
      );
      (
        noticeArchiveService.getSummaryStateByNoticeNums as jest.Mock
      ).mockResolvedValue(new Map());
      (
        summaryGenerationService.enrichNoticesWithSummary as jest.Mock
      ).mockResolvedValue(
        mockTableData.map((notice) => ({
          ...notice,
          aiSummary: '요약',
          aiSummaryStatus: 'ready',
        })),
      );
      (
        archiveOrchestratorService.filterAlreadyArchivedNotices as jest.Mock
      ).mockResolvedValue(mockTableData);
      (cacheService.updateCache as jest.Mock).mockResolvedValue(undefined);

      await service.onModuleInit();

      // Wait for background initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(crawlingCoreService.crawlAllPages).toHaveBeenCalled();
      expect(
        summaryGenerationService.enrichNoticesWithSummary,
      ).toHaveBeenCalledWith(mockTableData, new Map(), new Map(), {
        logOllamaActivity: true,
        phase: 'init-cache',
        retryUnavailableArchiveSummary: true,
      });
      expect(cacheService.updateCache).toHaveBeenCalled();
    });

    it('should handle initialization errors gracefully', async () => {
      const error = new Error('Initialization failed');
      (crawlingCoreService.crawlAllPages as jest.Mock).mockRejectedValue(error);

      await service.onModuleInit();

      // Wait for background initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(crawlingCoreService.crawlAllPages).toHaveBeenCalled();
      // Service should still be marked as initialized even on error
    });
  });

  describe('handleCron', () => {
    beforeEach(() => {
      // Set service as initialized
      (service as any).isInitialized = true;
      (service as any).isProcessing = false;
    });

    it('should skip if cache not initialized', async () => {
      (service as any).isInitialized = false;

      await service.handleCron();

      expect(crawlingCoreService.crawlAllPages).not.toHaveBeenCalled();
    });

    it('should skip if already processing', async () => {
      (service as any).isProcessing = true;

      await service.handleCron();

      expect(crawlingCoreService.crawlAllPages).not.toHaveBeenCalled();
    });

    it('should perform crawling and notification when new notices found', async () => {
      const newNotices = [mockTableData[0]];
      const existingNotices = [mockTableData[1]];

      (crawlingCoreService.crawlAllPages as jest.Mock).mockResolvedValue(
        mockTableData,
      );
      (cacheService.findNewNotices as jest.Mock).mockResolvedValue(newNotices);
      (
        archiveOrchestratorService.filterAlreadyArchivedNotices as jest.Mock
      ).mockResolvedValue(newNotices);
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        existingNotices,
      );
      (
        noticeArchiveService.getSummaryStateByNoticeNums as jest.Mock
      ).mockResolvedValue(new Map());
      (
        summaryGenerationService.enrichNoticesWithSummary as jest.Mock
      ).mockResolvedValue(
        newNotices.map((notice) => ({
          ...notice,
          aiSummary: '요약',
          aiSummaryStatus: 'ready',
        })),
      );
      (cacheService.updateCache as jest.Mock).mockResolvedValue(undefined);
      (
        notificationOrchestratorService.sendNotifications as jest.Mock
      ).mockResolvedValue(undefined);

      await service.handleCron();
      // processNewNoticesInBackground is fire-and-forget; flush microtasks so
      // sendNotifications (also void'd inside it) has a chance to execute
      await new Promise((resolve) => setImmediate(resolve));

      expect(crawlingCoreService.crawlAllPages).toHaveBeenCalled();
      expect(cacheService.findNewNotices).toHaveBeenCalledWith(mockTableData);
      expect(
        archiveOrchestratorService.filterAlreadyArchivedNotices,
      ).toHaveBeenCalledWith(newNotices);
      expect(
        summaryGenerationService.enrichNoticesWithSummary,
      ).toHaveBeenCalled();
      expect(archiveOrchestratorService.archiveNotices).toHaveBeenCalled();
      expect(cacheService.updateCache).toHaveBeenCalled();
      expect(
        notificationOrchestratorService.sendNotifications,
      ).toHaveBeenCalled();
    });

    it('should suppress generated summaries when persisted summary state is missing', async () => {
      const newNotices = [mockTableData[0]];
      const existingNotices = [mockTableData[1]];

      (crawlingCoreService.crawlAllPages as jest.Mock).mockResolvedValue(
        mockTableData,
      );
      (cacheService.findNewNotices as jest.Mock).mockResolvedValue(newNotices);
      (
        archiveOrchestratorService.filterAlreadyArchivedNotices as jest.Mock
      ).mockResolvedValue(newNotices);
      (cacheService.getRecentNotices as jest.Mock)
        .mockResolvedValueOnce(existingNotices)
        .mockResolvedValueOnce([
          {
            ...mockTableData[0],
            aiSummary: null,
            aiSummaryStatus: 'not_requested' as const,
          },
          ...existingNotices,
        ]);
      (noticeArchiveService.getSummaryStateByNoticeNums as jest.Mock)
        .mockResolvedValueOnce(new Map())
        .mockResolvedValueOnce(new Map());
      (
        summaryGenerationService.enrichNoticesWithSummary as jest.Mock
      ).mockResolvedValue([
        {
          ...mockTableData[0],
          aiSummary: '생성됐지만 미저장 요약',
          aiSummaryStatus: 'ready',
        },
      ]);
      (cacheService.updateCache as jest.Mock).mockResolvedValue(undefined);
      (
        notificationOrchestratorService.sendNotifications as jest.Mock
      ).mockResolvedValue(undefined);

      await service.handleCron();
      await new Promise((resolve) => setImmediate(resolve));

      expect(cacheService.updateCache).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            num: mockTableData[0].num,
            aiSummary: null,
            aiSummaryStatus: 'not_requested',
          }),
        ]),
      );
      expect(
        notificationOrchestratorService.sendNotifications,
      ).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            num: mockTableData[0].num,
            aiSummary: null,
            aiSummaryStatus: 'not_requested',
          }),
        ]),
      );
    });

    it('should handle no new notices gracefully', async () => {
      (crawlingCoreService.crawlAllPages as jest.Mock).mockResolvedValue(
        mockTableData,
      );
      (cacheService.findNewNotices as jest.Mock).mockResolvedValue([]);
      (
        archiveOrchestratorService.filterAlreadyArchivedNotices as jest.Mock
      ).mockResolvedValue([]);
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        mockTableData,
      );
      (
        summaryGenerationService.enrichNoticesWithSummary as jest.Mock
      ).mockResolvedValue(mockTableData);
      (cacheService.updateCache as jest.Mock).mockResolvedValue(undefined);

      await service.handleCron();

      expect(crawlingCoreService.crawlAllPages).toHaveBeenCalled();
      expect(archiveOrchestratorService.archiveNotices).not.toHaveBeenCalled();
      expect(
        notificationOrchestratorService.sendNotifications,
      ).not.toHaveBeenCalled();
      expect(cacheService.updateCache).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const error = new Error('Crawling failed');
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([]);
      (crawlingCoreService.crawlAllPages as jest.Mock).mockRejectedValue(error);

      await service.handleCron();

      expect(crawlingCoreService.crawlAllPages).toHaveBeenCalled();
      // Should not throw, just log error
    });

    it('should fall back to archive-based dedup when Redis is unavailable', async () => {
      const existingNotices = [mockTableData[1]];

      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        existingNotices,
      );
      (crawlingCoreService.crawlAllPages as jest.Mock).mockResolvedValue(
        mockTableData,
      );
      // findNewNotices throws -> cache fallback path
      (cacheService.findNewNotices as jest.Mock).mockRejectedValue(
        new Error('Redis connection refused'),
      );
      // archive filter receives full crawledData and keeps only truly new items
      (
        archiveOrchestratorService.filterAlreadyArchivedNotices as jest.Mock
      ).mockResolvedValue([mockTableData[0]]);
      (
        noticeArchiveService.getSummaryStateByNoticeNums as jest.Mock
      ).mockResolvedValue(new Map());
      (
        summaryGenerationService.enrichNoticesWithSummary as jest.Mock
      ).mockResolvedValue([
        { ...mockTableData[0], aiSummary: '요약', aiSummaryStatus: 'ready' },
      ]);
      (cacheService.updateCache as jest.Mock).mockResolvedValue(undefined);
      (
        notificationOrchestratorService.sendNotifications as jest.Mock
      ).mockResolvedValue(undefined);

      await service.handleCron();
      // processNewNoticesInBackground is fire-and-forget; flush microtasks so
      // sendNotifications (also void'd inside it) has a chance to execute
      await new Promise((resolve) => setImmediate(resolve));

      // archive filter should receive the full crawledData as the fallback
      expect(
        archiveOrchestratorService.filterAlreadyArchivedNotices,
      ).toHaveBeenCalledWith(mockTableData);
      // notifications must still fire for genuinely new items
      expect(
        notificationOrchestratorService.sendNotifications,
      ).toHaveBeenCalled();
    });

    it('should reset processing flag after completion', async () => {
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([]);
      (crawlingCoreService.crawlAllPages as jest.Mock).mockResolvedValue([]);
      (cacheService.findNewNotices as jest.Mock).mockResolvedValue([]);

      await service.handleCron();

      expect((service as any).isProcessing).toBe(false);
    });

    it('should reset processing flag even on error', async () => {
      const error = new Error('Processing failed');
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([]);
      (crawlingCoreService.crawlAllPages as jest.Mock).mockRejectedValue(error);

      await service.handleCron();

      expect((service as any).isProcessing).toBe(false);
    });
  });

  describe('handlePendingCron', () => {
    const mockRejectingPendingPages = (error: Error) => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(error),
      }),
    });

    const mockEmptyPendingPages = () => ({
      [Symbol.asyncIterator]: () => {
        let yielded = false;
        return {
          next: () => {
            if (!yielded) {
              yielded = true;
              return Promise.resolve({
                done: false,
                value: { items: [], totalPages: 1 },
              });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    });

    beforeEach(() => {
      (service as any).isInitialized = true;
    });

    it('should skip if cache not initialized', async () => {
      (service as any).isInitialized = false;

      await service.handlePendingCron();

      expect(crawlingCoreService.getAllNsmPendingPages).not.toHaveBeenCalled();
    });

    it('should retry on ECONNRESET with exponential backoff and succeed', async () => {
      const econnreset = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      });
      let callCount = 0;

      (
        crawlingCoreService.getAllNsmPendingPages as jest.Mock
      ).mockImplementation(() => {
        callCount += 1;
        if (callCount <= 2) {
          return mockRejectingPendingPages(econnreset);
        }
        return mockEmptyPendingPages();
      });

      jest.useFakeTimers();
      const pendingCronPromise = service.handlePendingCron();
      await jest.runAllTimersAsync();
      await pendingCronPromise;
      jest.useRealTimers();

      expect(callCount).toBe(3);
    });

    it('should not retry on non-network errors', async () => {
      (
        crawlingCoreService.getAllNsmPendingPages as jest.Mock
      ).mockImplementation(() =>
        mockRejectingPendingPages(new Error('Database unavailable')),
      );

      await service.handlePendingCron();

      expect(crawlingCoreService.getAllNsmPendingPages).toHaveBeenCalledTimes(
        1,
      );
    });

    it('should stop after exhausting retry budget on persistent ECONNRESET', async () => {
      const econnreset = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      });
      const expectedAttempts =
        APP_CONSTANTS.ARCHIVE_SYNC.PENDING_CRAWL_MAX_RETRIES + 1;

      (
        crawlingCoreService.getAllNsmPendingPages as jest.Mock
      ).mockImplementation(() => mockRejectingPendingPages(econnreset));

      jest.useFakeTimers();
      const pendingCronPromise = service.handlePendingCron();
      await jest.runAllTimersAsync();
      await pendingCronPromise;
      jest.useRealTimers();

      expect(crawlingCoreService.getAllNsmPendingPages).toHaveBeenCalledTimes(
        expectedAttempts,
      );
    });
  });
});
