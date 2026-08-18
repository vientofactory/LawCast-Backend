import { Test, TestingModule } from '@nestjs/testing';
import { BrowserLeaseManagerService } from './browser-lease-manager.service';
import {
  CrawlingCoreService,
  NsmBillDeletedError,
} from './crawling-core.service';
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

  it('passes the configured title hydration option to NSM clients', async () => {
    (mockNsmLmSts as any).getAllPages = jest
      .fn()
      .mockReturnValue((async function* () {})());

    for await (const _page of service.getAllNsmPages()) {
      // Empty mocked stream.
    }

    expect(NsmLmSts).toHaveBeenCalledWith(
      expect.objectContaining({ hydrateTruncatedTitles: false }),
    );
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

  describe('nsmBillToCachedNotice', () => {
    it('prefers committee recovery when committee text exists', () => {
      const result = CrawlingCoreService.nsmBillToCachedNotice({
        billNo: '2219991',
        billName: '위원회 복구 테스트',
        proposer: '홍길동의원',
        committee: '정무위',
        ministry: '법무부',
        link: 'https://example.com/2219991',
      } as any);

      expect(result.committee).toBe('정무위원회');
    });

    it('prefers ministry recovery when committee is empty and only ministry is provided', () => {
      const result = CrawlingCoreService.nsmBillToCachedNotice({
        billNo: '2219992',
        billName: '부처 복구 테스트',
        proposer: '법무부장관',
        committee: '',
        ministry: '과학기술정보통신',
        link: 'https://example.com/2219992',
      } as any);

      expect(result.committee).toBe('과학기술정보통신부');
    });
  });

  describe('browser lease coverage', () => {
    it('throws NsmBillDeletedError only when alert and deleted structure are both present', async () => {
      mockPage.content.mockResolvedValue(`
        <html>
          <body>
            <script>alert("안건정보가 없습니다."); history.back();</script>
          </body>
        </html>
      `);

      await expect(
        service.captureNsmDetailFull('2219887'),
      ).rejects.toBeInstanceOf(NsmBillDeletedError);
    });

    it('does not treat alert-only page as deleted when normal core structure exists even without proposal reason section', async () => {
      mockPage.content.mockResolvedValue(`
        <html>
          <body>
            <div id="containerWrap" class="containerWrap">
              <h2 class="subjectHead_tit">테스트 법률안</h2>
              <div class="gridCnt_table"><table><tbody><tr><th>발의정보</th><td>내용</td></tr></tbody></table></div>
              <form name="VIEW_FM"></form>
            </div>
            <script>alert("안건정보가 없습니다.");</script>
          </body>
        </html>
      `);

      const result = await service.captureNsmDetailFull('2219887');
      expect(result.detail).toEqual({ proposalReason: 'reason' });
    });

    it('does not treat page as deleted when one core detail wrapper exists', async () => {
      mockPage.content.mockResolvedValue(`
        <html>
          <body>
            <div id="containerWrap"></div>
            <script>alert("안건정보가 없습니다."); history.back();</script>
          </body>
        </html>
      `);

      const result = await service.captureNsmDetailFull('2219887');
      expect(result.detail).toEqual({ proposalReason: 'reason' });
    });

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
