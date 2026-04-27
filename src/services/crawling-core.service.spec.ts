import { Test, TestingModule } from '@nestjs/testing';
import { CrawlingCoreService } from './crawling-core.service';
import { PalCrawl, type ITableData } from 'pal-crawl';

// pal-crawl 모듈을 모킹
jest.mock('pal-crawl');

describe('CrawlingCoreService', () => {
  let service: CrawlingCoreService;
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
      providers: [CrawlingCoreService],
    }).compile();

    service = module.get<CrawlingCoreService>(CrawlingCoreService);
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
});
