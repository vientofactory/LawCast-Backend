import { Test, TestingModule } from '@nestjs/testing';
import { CrawlingSchedulerService } from './crawling-scheduler.service';
import { CacheService } from './cache.service';
import { CrawlingCoreService } from './crawling-core.service';
import { SummaryGenerationService } from './summary-generation.service';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { NotificationOrchestratorService } from './notification-orchestrator.service';
import { NoticeArchiveService } from './notice-archive.service';
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrawlingSchedulerService,
        {
          provide: CacheService,
          useValue: {
            updateCache: jest.fn(),
            findNewNotices: jest.fn(),
            getRecentNotices: jest.fn(),
          },
        },
        {
          provide: CrawlingCoreService,
          useValue: {
            crawlData: jest.fn(),
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
      (crawlingCoreService.crawlData as jest.Mock).mockResolvedValue(
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

      expect(crawlingCoreService.crawlData).toHaveBeenCalled();
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
      (crawlingCoreService.crawlData as jest.Mock).mockRejectedValue(error);

      await service.onModuleInit();

      // Wait for background initialization
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(crawlingCoreService.crawlData).toHaveBeenCalled();
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

      expect(crawlingCoreService.crawlData).not.toHaveBeenCalled();
    });

    it('should skip if already processing', async () => {
      (service as any).isProcessing = true;

      await service.handleCron();

      expect(crawlingCoreService.crawlData).not.toHaveBeenCalled();
    });

    it('should perform crawling and notification when new notices found', async () => {
      const newNotices = [mockTableData[0]];
      const existingNotices = [mockTableData[1]];

      (crawlingCoreService.crawlData as jest.Mock).mockResolvedValue(
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

      expect(crawlingCoreService.crawlData).toHaveBeenCalled();
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

    it('should handle no new notices gracefully', async () => {
      (crawlingCoreService.crawlData as jest.Mock).mockResolvedValue(
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

      expect(crawlingCoreService.crawlData).toHaveBeenCalled();
      expect(cacheService.findNewNotices).toHaveBeenCalledWith(mockTableData);
      expect(
        archiveOrchestratorService.filterAlreadyArchivedNotices,
      ).toHaveBeenCalledWith([]);
      expect(archiveOrchestratorService.archiveNotices).not.toHaveBeenCalled();
      expect(
        notificationOrchestratorService.sendNotifications,
      ).not.toHaveBeenCalled();
      expect(cacheService.updateCache).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      const error = new Error('Crawling failed');
      (crawlingCoreService.crawlData as jest.Mock).mockRejectedValue(error);

      await service.handleCron();

      expect(crawlingCoreService.crawlData).toHaveBeenCalled();
      // Should not throw, just log error
    });

    it('should reset processing flag after completion', async () => {
      (crawlingCoreService.crawlData as jest.Mock).mockResolvedValue([]);
      (cacheService.findNewNotices as jest.Mock).mockResolvedValue([]);

      await service.handleCron();

      expect((service as any).isProcessing).toBe(false);
    });

    it('should reset processing flag even on error', async () => {
      const error = new Error('Processing failed');
      (crawlingCoreService.crawlData as jest.Mock).mockRejectedValue(error);

      await service.handleCron();

      expect((service as any).isProcessing).toBe(false);
    });
  });
});
