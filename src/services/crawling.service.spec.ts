import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CrawlingService } from './crawling.service';
import { CacheService } from './cache.service';
import { BatchProcessingService } from './batch-processing.service';
import { PalCrawl, type ITableData } from 'pal-crawl';

// pal-crawl 모듈을 모킹
jest.mock('pal-crawl');

describe('CrawlingService', () => {
  let service: CrawlingService;
  let cacheService: CacheService;

  let mockPalCrawl: jest.Mocked<PalCrawl>;

  const mockTableData: ITableData[] = [
    {
      num: 1,
      subject: '테스트 입법예고 1',
      proposerCategory: '정부',
      committee: '법제사법위원회',
      numComments: 5,
      link: '/test/link/1',
      attachments: { pdfFile: '', hwpFile: '' },
    },
    {
      num: 2,
      subject: '테스트 입법예고 2',
      proposerCategory: '의원',
      committee: '국정감사위원회',
      numComments: 3,
      link: '/test/link/2',
      attachments: { pdfFile: '', hwpFile: '' },
    },
  ];

  beforeEach(async () => {
    // PalCrawl 모킹
    mockPalCrawl = {
      get: jest.fn(),
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
    it('should initialize cache successfully', async () => {
      mockPalCrawl.get.mockResolvedValue(mockTableData);

      await service.onModuleInit();

      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(cacheService.updateCache).toHaveBeenCalledWith(mockTableData);
    });

    it('should handle empty data during initialization', async () => {
      mockPalCrawl.get.mockResolvedValue([]);

      await service.onModuleInit();

      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(cacheService.updateCache).not.toHaveBeenCalled();
    });

    it('should handle null data during initialization', async () => {
      mockPalCrawl.get.mockResolvedValue(null as any);

      await service.onModuleInit();

      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(cacheService.updateCache).not.toHaveBeenCalled();
    });

    it('should handle crawling errors during initialization gracefully', async () => {
      const error = new Error('Network timeout');
      mockPalCrawl.get.mockRejectedValue(error);

      // onModuleInit은 에러를 catch하고 다시 throw함
      await expect(service.onModuleInit()).rejects.toThrow('Network timeout');
      expect(cacheService.updateCache).not.toHaveBeenCalled();
    });

    it('should handle timeout errors specifically during initialization gracefully', async () => {
      const timeoutError = new Error('Request timeout');
      mockPalCrawl.get.mockRejectedValue(timeoutError);

      // onModuleInit은 에러를 catch하고 다시 throw함
      await expect(service.onModuleInit()).rejects.toThrow('Request timeout');
    });
  });

  describe('getRecentNotices', () => {
    it('should return recent notices from cache', async () => {
      const expectedNotices = mockTableData.slice(0, 2);
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        expectedNotices,
      );

      const result = await service.getRecentNotices(2);

      expect(cacheService.getRecentNotices).toHaveBeenCalledWith(2);
      expect(result).toEqual(expectedNotices);
    });

    it('should use default limit when no limit provided', async () => {
      const expectedNotices = mockTableData;
      (cacheService.getRecentNotices as jest.Mock).mockResolvedValue(
        expectedNotices,
      );

      const result = await service.getRecentNotices();

      expect(cacheService.getRecentNotices).toHaveBeenCalledWith(10); // APP_CONSTANTS.CACHE.DEFAULT_LIMIT
      expect(result).toEqual(expectedNotices);
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

      // onModuleInit은 에러를 catch하고 다시 throw함
      await expect(service.onModuleInit()).rejects.toThrow(
        'Network error during request',
      );
    });

    it('should provide specific timeout error messages', async () => {
      const timeoutError = new Error('Request timeout after 15000ms');
      mockPalCrawl.get.mockRejectedValue(timeoutError);

      // onModuleInit은 에러를 catch하고 다시 throw함
      await expect(service.onModuleInit()).rejects.toThrow(
        'Request timeout after 15000ms',
      );
    });
  });
});
