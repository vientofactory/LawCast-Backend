import { Test, TestingModule } from '@nestjs/testing';
import { BrowserLeaseManagerService } from './browser-lease-manager.service';
import { CrawlingCoreService } from './crawling-core.service';
import { NsmLmSts, NsmLmStsParser, PalCrawl, type ITableData } from 'pal-crawl';

// pal-crawl 모듈을 모킹
jest.mock('pal-crawl');

describe('CrawlingCoreService', () => {
  let service: CrawlingCoreService;
  let browserLeaseManager: BrowserLeaseManagerService;
  let mockPalCrawl: jest.Mocked<PalCrawl>;
  let mockNsmLmSts: {
    initBrowser: jest.Mock;
    closeBrowser: jest.Mock;
    getDetailScreenshot: jest.Mock;
    browser: {
      newPage: jest.Mock;
    };
  };
  let mockNsmLmStsParser: {
    parseDetail: jest.Mock;
  };
  let mockPage: {
    setViewport: jest.Mock;
    goto: jest.Mock;
    waitForNavigation: jest.Mock;
    title: jest.Mock;
    content: jest.Mock;
    url: jest.Mock;
    evaluate: jest.Mock;
    screenshot: jest.Mock;
    close: jest.Mock;
  };

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

  beforeEach(async () => {
    // PalCrawl 모킹
    mockPalCrawl = {
      get: jest.fn(),
      getContent: jest.fn(),
      getContentScreenshot: jest.fn(),
      getDoneContentScreenshot: jest.fn(),
      closeBrowser: jest.fn(),
    } as any;

    mockPage = {
      setViewport: jest.fn().mockResolvedValue(undefined),
      goto: jest.fn().mockResolvedValue({ status: () => 200 }),
      waitForNavigation: jest.fn().mockResolvedValue(null),
      title: jest.fn().mockResolvedValue('Detail Page'),
      content: jest.fn().mockResolvedValue('<html></html>'),
      url: jest.fn().mockReturnValue('https://example.com/detail'),
      evaluate: jest.fn(),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('jpeg')),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockNsmLmSts = {
      initBrowser: jest.fn().mockResolvedValue(undefined),
      closeBrowser: jest.fn().mockResolvedValue(undefined),
      getDetailScreenshot: jest.fn().mockResolvedValue(Buffer.from('jpeg')),
      browser: {
        newPage: jest.fn().mockResolvedValue(mockPage),
      },
    };

    mockNsmLmStsParser = {
      parseDetail: jest.fn().mockReturnValue({ proposalReason: 'reason' }),
    };

    (PalCrawl as jest.MockedClass<typeof PalCrawl>).mockImplementation(
      () => mockPalCrawl,
    );
    (NsmLmSts as jest.MockedClass<typeof NsmLmSts>).mockImplementation(
      () => mockNsmLmSts as any,
    );
    (
      NsmLmStsParser as jest.MockedClass<typeof NsmLmStsParser>
    ).mockImplementation(() => mockNsmLmStsParser as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [BrowserLeaseManagerService, CrawlingCoreService],
    }).compile();

    service = module.get<CrawlingCoreService>(CrawlingCoreService);
    browserLeaseManager = module.get<BrowserLeaseManagerService>(
      BrowserLeaseManagerService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('crawlData', () => {
    it('should return crawled data successfully', async () => {
      mockPalCrawl.get.mockResolvedValue(mockTableData);

      const result = await service.crawlData();

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
      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockTableData);
    });

    it('should return empty array when no data received', async () => {
      mockPalCrawl.get.mockResolvedValue([]);

      const result = await service.crawlData();

      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });

    it('should return empty array when null data received', async () => {
      mockPalCrawl.get.mockResolvedValue(null as any);

      const result = await service.crawlData();

      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });

    it('should throw error when crawling fails', async () => {
      const error = new Error('Crawling failed');
      mockPalCrawl.get.mockRejectedValue(error);

      await expect(service.crawlData()).rejects.toThrow('Crawling failed');
      expect(mockPalCrawl.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('getContent', () => {
    it('should return content for given contentId', async () => {
      const contentId = 'test-content-id';
      const mockContent = {
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
        billNumber: 'Test Bill Number',
        proposer: 'Test Proposer',
        proposalDate: '2024-01-01',
        committee: 'Test Committee',
        referralDate: '2024-01-02',
        noticePeriod: 'Test Period',
        proposalSession: 'Test Session',
      };
      mockPalCrawl.getContent.mockResolvedValue(mockContent as any);

      const result = await service.getContent(contentId);

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
      expect(mockPalCrawl.getContent).toHaveBeenCalledWith(contentId);
      expect(result).toEqual(mockContent);
    });

    it('should throw error when getContent fails', async () => {
      const contentId = 'test-content-id';
      const error = new Error('Content retrieval failed');
      mockPalCrawl.getContent.mockRejectedValue(error);

      await expect(service.getContent(contentId)).rejects.toThrow(
        'Content retrieval failed',
      );
      expect(mockPalCrawl.getContent).toHaveBeenCalledWith(contentId);
    });
  });

  describe('browser lease coverage', () => {
    it('wraps captureNsmDetailFull with the shared browser lease manager', async () => {
      const guardSpy = jest
        .spyOn(browserLeaseManager, 'runWithLease')
        .mockImplementation(async (_label, _session, task) => task(_session));

      await service.captureNsmDetailFull(' 2219887 ');

      expect(guardSpy).toHaveBeenCalledWith(
        'captureNsmDetailFull(2219887)',
        expect.anything(),
        expect.any(Function),
      );
      expect(mockNsmLmSts.initBrowser).toHaveBeenCalledTimes(1);
    });

    it('wraps captureNsmDetailScreenshot with the shared browser lease manager', async () => {
      const guardSpy = jest
        .spyOn(browserLeaseManager, 'runWithLease')
        .mockImplementation(async (_label, _session, task) => task(_session));

      await service.captureNsmDetailScreenshot('2219887');

      expect(guardSpy).toHaveBeenCalledWith(
        'captureNsmDetailScreenshot(2219887)',
        expect.anything(),
        expect.any(Function),
      );
      expect(mockNsmLmSts.getDetailScreenshot).toHaveBeenCalledWith('2219887');
    });

    it('wraps captureContentScreenshot with the shared browser lease manager', async () => {
      mockPalCrawl.getContentScreenshot.mockResolvedValue(Buffer.from('jpeg'));
      const guardSpy = jest
        .spyOn(browserLeaseManager, 'runWithLease')
        .mockImplementation(async (_label, _session, task) => task(_session));

      await service.captureContentScreenshot('content-123');

      expect(guardSpy).toHaveBeenCalledWith(
        'captureContentScreenshot(content-123, fullPage=true)',
        expect.anything(),
        expect.any(Function),
      );
      expect(mockPalCrawl.getContentScreenshot).toHaveBeenCalledWith(
        'content-123',
      );
    });
  });
});
