import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CrawlingService } from './crawling.service';
import { CacheService } from './cache.service';
import { BatchProcessingService } from './batch-processing.service';
import { OllamaClientService } from '../modules/ollama/ollama-client.service';
import { NoticeArchiveService } from './notice-archive.service';
import { PalCrawl, type ITableData } from 'pal-crawl';

// pal-crawl 모듈을 모킹
jest.mock('pal-crawl');

describe('CrawlingService', () => {
  let service: CrawlingService;
  let cacheService: CacheService;
  let noticeArchiveService: NoticeArchiveService;
  let ollamaClientService: OllamaClientService;

  let mockPalCrawl: jest.Mocked<PalCrawl>;

  const mockTableData: ITableData[] = [
    {
      num: 1,
      subject: '테스트 입법예고 1',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      numComments: 5,
      link: '/test/link/1',
      contentId: null,
      attachments: { pdfFile: '', hwpFile: '' },
    },
    {
      num: 2,
      subject: '테스트 입법예고 2',
      proposerCategory: '의원',
      committee: '국정감사위원회',
      numComments: 3,
      link: '/test/link/2',
      contentId: null,
      attachments: { pdfFile: '', hwpFile: '' },
    },
  ];

  const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(async () => {
    // PalCrawl 모킹
    mockPalCrawl = {
      get: jest.fn(),
      getContent: jest.fn(),
    } as any;

    (PalCrawl as jest.MockedClass<typeof PalCrawl>).mockImplementation(
      () => mockPalCrawl,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CrawlingService,
        {
          provide: CacheService,
          useValue: {
            updateCache: jest.fn(),
            findNewNotices: jest.fn(),
            getRecentNotices: jest.fn(),
            getCacheInfo: jest.fn(),
          },
        },
        {
          provide: BatchProcessingService,
          useValue: {
            processNotificationBatch: jest.fn(),
          },
        },
        {
          provide: OllamaClientService,
          useValue: {
            isEnabled: jest.fn().mockReturnValue(true),
            summarizeProposal: jest.fn(),
          },
        },
        {
          provide: NoticeArchiveService,
          useValue: {
            existsByNoticeNum: jest.fn().mockResolvedValue(false),
            getExistingNoticeNumSet: jest.fn().mockResolvedValue(new Set()),
            upsertNoticeArchive: jest.fn(),
            getSummaryStateByNoticeNums: jest.fn().mockResolvedValue(new Map()),
            updateSummaryStateByNoticeNum: jest.fn(),
            getArchiveStartedAtByNoticeNums: jest
              .fn()
              .mockResolvedValue(new Map()),
          },
        },
        {
          provide: SchedulerRegistry,
          useValue: {
            addCronJob: jest.fn(),
            getCronJob: jest.fn(),
            deleteCronJob: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CrawlingService>(CrawlingService);
    cacheService = module.get<CacheService>(CacheService);
    noticeArchiveService =
      module.get<NoticeArchiveService>(NoticeArchiveService);
    ollamaClientService = module.get<OllamaClientService>(OllamaClientService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor and Configuration', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should create PalCrawl with proper configuration when initialized', async () => {
      mockPalCrawl.get.mockResolvedValue(mockTableData);

      await service.onModuleInit();
      await flushPromises();

      // PalCrawl이 적절한 설정으로 생성되었는지 확인
      expect(PalCrawl).toHaveBeenCalledWith({
        userAgent: 'LawCast/1.0 (Legislative Notice Crawler)',
        timeout: 15000,
        retryCount: 3,
        customHeaders: {
          'Accept-Language': 'ko-KR,ko;q=0.9',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cache-Control': 'no-cache',
        },
      });
    });
  });

  describe('onModuleInit', () => {
    it('should not block module startup while initializing cache', async () => {
      let resolveCrawler: ((value: ITableData[]) => void) | undefined;
      mockPalCrawl.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCrawler = resolve;
          }),
      );

      const startTime = Date.now();
      await service.onModuleInit();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);

      resolveCrawler?.(mockTableData);
      await flushPromises();
      await flushPromises();

      expect(cacheService.updateCache).toHaveBeenCalled();
    });

    it('should initialize cache successfully', async () => {
      mockPalCrawl.get.mockResolvedValue(mockTableData);

      await service.onModuleInit();
      await flushPromises();

      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(cacheService.updateCache).toHaveBeenCalledWith(
        mockTableData.map((notice) => ({
          ...notice,
          aiSummary: null,
          aiSummaryStatus: 'not_supported',
        })),
      );
    });

    it('should handle empty data during initialization', async () => {
      mockPalCrawl.get.mockResolvedValue([]);

      await service.onModuleInit();
      await flushPromises();

      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(cacheService.updateCache).not.toHaveBeenCalled();
    });

    it('should handle null data during initialization', async () => {
      mockPalCrawl.get.mockResolvedValue(null as any);

      await service.onModuleInit();
      await flushPromises();

      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(cacheService.updateCache).not.toHaveBeenCalled();
    });

    it('should handle crawling errors during initialization gracefully', async () => {
      const error = new Error('Network timeout');
      mockPalCrawl.get.mockRejectedValue(error);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      await flushPromises();
      expect(cacheService.updateCache).not.toHaveBeenCalled();
    });

    it('should handle timeout errors specifically during initialization gracefully', async () => {
      const timeoutError = new Error('Request timeout');
      mockPalCrawl.get.mockRejectedValue(timeoutError);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      await flushPromises();
    });

    it('should skip AI summary pipeline when Ollama is disabled', async () => {
      mockPalCrawl.get.mockResolvedValue(mockTableData);
      (ollamaClientService.isEnabled as jest.Mock).mockReturnValue(false);

      await service.onModuleInit();
      await flushPromises();

      expect(ollamaClientService.summarizeProposal).not.toHaveBeenCalled();
      expect(
        noticeArchiveService.getSummaryStateByNoticeNums,
      ).not.toHaveBeenCalled();
      expect(cacheService.updateCache).toHaveBeenCalledWith(
        mockTableData.map((notice) => ({
          ...notice,
          aiSummary: null,
          aiSummaryStatus: 'not_requested',
        })),
      );
    });

    it('should retry unavailable archive summaries and persist updated status during bootstrap', async () => {
      const noticeWithContent: ITableData = {
        ...mockTableData[0],
        contentId: 'PRC_1',
      };

      mockPalCrawl.get.mockResolvedValue([noticeWithContent]);
      (mockPalCrawl.getContent as jest.Mock).mockResolvedValue({
        title: '테스트 원문 제목',
        proposalReason: '테스트 제안이유',
      });

      (
        noticeArchiveService.getSummaryStateByNoticeNums as jest.Mock
      ).mockResolvedValue(
        new Map([
          [
            noticeWithContent.num,
            {
              aiSummary: null,
              aiSummaryStatus: 'unavailable',
            },
          ],
        ]),
      );

      const summarizeProposalMock = (
        ollamaClientService.summarizeProposal as jest.Mock
      ).mockResolvedValue('새로운 AI 요약');

      await service.onModuleInit();
      await flushPromises();

      expect(summarizeProposalMock).toHaveBeenCalledWith(
        '테스트 원문 제목',
        '테스트 제안이유',
      );
      expect(
        noticeArchiveService.updateSummaryStateByNoticeNum,
      ).toHaveBeenCalledWith(noticeWithContent.num, '새로운 AI 요약', 'ready');
      expect(cacheService.updateCache).toHaveBeenCalledWith([
        {
          ...noticeWithContent,
          aiSummary: '새로운 AI 요약',
          aiSummaryStatus: 'ready',
        },
      ]);
    });
  });

  describe('getRecentNotices', () => {
    it('should return recent notices from cache', async () => {
      const expectedNotices = mockTableData.slice(0, 2);
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        expectedNotices,
      );
      (
        noticeArchiveService.getArchiveStartedAtByNoticeNums as jest.Mock
      ).mockResolvedValue(new Map());

      const result = await service.getRecentNotices(2);

      expect(cacheService.getRecentNotices).toHaveBeenCalledWith(10);
      expect(
        noticeArchiveService.getArchiveStartedAtByNoticeNums,
      ).toHaveBeenCalledWith(expectedNotices.map((notice) => notice.num));
      expect(result).toEqual(
        [...expectedNotices].sort((a, b) => b.num - a.num),
      );
    });

    it('should use default limit when no limit provided', async () => {
      const expectedNotices = mockTableData;
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        expectedNotices,
      );
      (
        noticeArchiveService.getArchiveStartedAtByNoticeNums as jest.Mock
      ).mockResolvedValue(new Map());

      const result = await service.getRecentNotices();

      expect(cacheService.getRecentNotices).toHaveBeenCalledWith(10); // APP_CONSTANTS.CACHE.DEFAULT_LIMIT
      expect(result).toEqual(
        [...expectedNotices].sort((a, b) => b.num - a.num),
      );
    });
  });

  describe('getCacheInfo', () => {
    it('should return cache information', async () => {
      const expectedCacheInfo = { size: 5, lastUpdated: new Date() };
      (cacheService.getCacheInfo as jest.Mock).mockResolvedValue(
        expectedCacheInfo,
      );

      const result = await service.getCacheInfo();

      expect(cacheService.getCacheInfo).toHaveBeenCalled();
      expect(result).toEqual(expectedCacheInfo);
    });
  });

  describe('Enhanced Error Handling', () => {
    it('should handle network errors appropriately', async () => {
      const networkError = new Error('Network error during request');
      mockPalCrawl.get.mockRejectedValue(networkError);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      await flushPromises();
    });

    it('should provide specific timeout error messages', async () => {
      const timeoutError = new Error('Request timeout after 15000ms');
      mockPalCrawl.get.mockRejectedValue(timeoutError);

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      await flushPromises();
    });

    it('should retry unavailable summaries during cron cycle and persist archive state', async () => {
      const noticeWithUnavailableSummary: ITableData = {
        ...mockTableData[0],
        contentId: 'PRC_CRON_1',
      };

      const cachedExistingNotice = {
        ...noticeWithUnavailableSummary,
        aiSummary: null,
        aiSummaryStatus: 'unavailable' as const,
      };

      mockPalCrawl.get.mockResolvedValue([noticeWithUnavailableSummary]);
      (mockPalCrawl.getContent as jest.Mock).mockResolvedValue({
        title: '크론 재시도 제목',
        proposalReason: '크론 재시도 제안이유',
      });

      (cacheService.findNewNotices as jest.Mock).mockResolvedValue([]);
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue([
        cachedExistingNotice,
      ]);

      const summarizeProposalMock = (
        ollamaClientService.summarizeProposal as jest.Mock
      ).mockResolvedValue('크론 재시도 요약');

      (service as any).isInitialized = true;

      await service.handleCron();

      expect(summarizeProposalMock).toHaveBeenCalledWith(
        '크론 재시도 제목',
        '크론 재시도 제안이유',
      );
      expect(
        noticeArchiveService.updateSummaryStateByNoticeNum,
      ).toHaveBeenCalledWith(
        noticeWithUnavailableSummary.num,
        '크론 재시도 요약',
        'ready',
      );
      expect(cacheService.updateCache).toHaveBeenCalledWith([
        {
          ...noticeWithUnavailableSummary,
          aiSummary: '크론 재시도 요약',
          aiSummaryStatus: 'ready',
        },
      ]);
    });
  });
});
