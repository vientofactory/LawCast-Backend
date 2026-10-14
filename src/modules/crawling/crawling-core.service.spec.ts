import { Test, TestingModule } from '@nestjs/testing';
import { BrowserLeaseManagerService } from './browser-lease-manager.service';
import {
  CrawlingCoreService,
  NsmBillDeletedError,
  NsmWaitingroomUnresolvedError,
} from './crawling-core.service';
import {
  NsmLmSts,
  NsmLmStsParser,
  PalCrawl,
  LikmsCrawler,
  LikmsNsmAdapter,
  type ITableData,
} from 'pal-crawl';
import { fetchHtmlPage } from '../../utils/http-fetch.utils';
import { BROWSER_IDENTITIES } from '../../utils/browser-identities.util';
import { buildBrowserRequestHeaders } from '../../utils/browser-request-headers.util';

// Mock pal-crawl module
jest.mock('pal-crawl');
jest.mock('../../utils/http-fetch.utils', () => ({
  fetchHtmlPage: jest.fn(),
}));

const mockFetchHtmlPage = fetchHtmlPage as jest.MockedFunction<
  typeof fetchHtmlPage
>;

/** A real browser identity, not the retired product token. */
const BROWSER_UA_PATTERN = /^Mozilla\/5\.0 \(/;

/**
 * Asserts a client config carries a browser identity whose User-Agent is in the
 * pool. The header set itself is verified on the wire in
 * `browser-request-headers.util.spec.ts`, because pal-crawl evaluates the
 * `customHeaders` accessors per request.
 */
function expectBrowserClientConfig(config: {
  userAgent?: string;
  customHeaders?: Record<string, string>;
}): void {
  expect(config.userAgent).toMatch(BROWSER_UA_PATTERN);
  expect(config.customHeaders?.['User-Agent']).toMatch(BROWSER_UA_PATTERN);
  expect(config.customHeaders?.Accept).toContain('text/html');
}

/**
 * Asserts a single fetch's headers are one coherent browser identity: every
 * hint header belongs to the User-Agent it is sent with.
 */
function expectBrowserFetchHeaders(config: {
  userAgent: string;
  customHeaders: Record<string, string>;
}): void {
  const identity = BROWSER_IDENTITIES.find(
    (entry) => entry.userAgent === config.userAgent,
  );

  expect(identity).toBeDefined();
  expect(config.customHeaders).toEqual(
    buildBrowserRequestHeaders(identity as (typeof BROWSER_IDENTITIES)[number]),
  );
}

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
  let mockLikmsAdapter: {
    getAllPages: jest.Mock;
    getAllPendingPages: jest.Mock;
    getDetail: jest.Mock;
  };
  let mockLikmsCrawler: {
    resolveBillId: jest.Mock;
  };
  let mockPage: {
    setViewport: jest.Mock;
    goto: jest.Mock;
    waitForNavigation: jest.Mock;
    waitForNetworkIdle: jest.Mock;
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
    // Mock PalCrawl
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
      waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
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

    mockLikmsAdapter = {
      getAllPages: jest.fn().mockReturnValue((async function* () {})()),
      getAllPendingPages: jest.fn().mockReturnValue((async function* () {})()),
      getDetail: jest.fn().mockResolvedValue({ proposalReason: 'reason' }),
    };

    mockLikmsCrawler = {
      resolveBillId: jest.fn().mockResolvedValue(null),
    };
    (LikmsCrawler as jest.MockedClass<typeof LikmsCrawler>).mockImplementation(
      () => mockLikmsCrawler as any,
    );

    (PalCrawl as jest.MockedClass<typeof PalCrawl>).mockImplementation(
      () => mockPalCrawl,
    );
    (NsmLmSts as jest.MockedClass<typeof NsmLmSts>).mockImplementation(
      () => mockNsmLmSts as any,
    );
    (
      NsmLmStsParser as jest.MockedClass<typeof NsmLmStsParser>
    ).mockImplementation(() => mockNsmLmStsParser as any);
    (
      LikmsNsmAdapter as jest.MockedClass<typeof LikmsNsmAdapter>
    ).mockImplementation(() => mockLikmsAdapter as any);

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

      expect(PalCrawl).toHaveBeenCalledTimes(1);
      const palConfig = (PalCrawl as jest.MockedClass<typeof PalCrawl>).mock
        .calls[0][0];
      expectBrowserClientConfig(palConfig);
      expect(palConfig).toEqual(
        expect.objectContaining({
          timeout: 15000,
          retryCount: 3,
          hydrateTruncatedTitles: false,
          hydrateProposalReason: true,
        }),
      );
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

  describe('getProposalReasonViaLikms', () => {
    const getProposalReason = jest.fn();

    beforeEach(() => {
      getProposalReason.mockReset();
      (
        LikmsCrawler as jest.MockedClass<typeof LikmsCrawler>
      ).mockImplementation(() => ({ getProposalReason }) as any);
    });

    it('queries the 국회 의안정보시스템 with the trimmed PAL contentId', async () => {
      getProposalReason.mockResolvedValue('제안이유 본문');

      const result = await service.getProposalReasonViaLikms('  PRC_TEST_1  ');

      expect(result).toBe('제안이유 본문');
      expect(getProposalReason).toHaveBeenCalledWith('PRC_TEST_1');
      expect(LikmsCrawler).toHaveBeenCalledTimes(1);
      const likmsClientConfig = (
        LikmsCrawler as jest.MockedClass<typeof LikmsCrawler>
      ).mock.calls[0][0];
      expectBrowserClientConfig(likmsClientConfig);
      expect(likmsClientConfig).toEqual(
        expect.objectContaining({ timeout: 15000, retryCount: 3 }),
      );
    });

    it('returns null without constructing a client when contentId is blank', async () => {
      const result = await service.getProposalReasonViaLikms('   ');

      expect(result).toBeNull();
      expect(LikmsCrawler).not.toHaveBeenCalled();
    });

    it('returns null when the crawler reports no reason', async () => {
      getProposalReason.mockResolvedValue(null);

      await expect(
        service.getProposalReasonViaLikms('PRC_TEST_2'),
      ).resolves.toBeNull();
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

      expect(PalCrawl).toHaveBeenCalledTimes(1);
      const palContentConfig = (PalCrawl as jest.MockedClass<typeof PalCrawl>)
        .mock.calls[0][0];
      expectBrowserClientConfig(palContentConfig);
      expect(palContentConfig).toEqual(
        expect.objectContaining({
          timeout: 15000,
          retryCount: 3,
          hydrateTruncatedTitles: false,
          // PAL collection must keep the pal-crawl 2.2.0 proposalReason
          // hydration path (empty PAL `제안이유` -> `국회 의안정보시스템` correction).
          hydrateProposalReason: true,
        }),
      );
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
    it('throws NsmWaitingroomUnresolvedError (not NsmBillDeletedError) when the Waitingroom is never bypassed, even if the leftover HTML looks like a deleted page', async () => {
      mockPage.title.mockResolvedValue('Waitingroom');
      mockPage.content.mockResolvedValue(`
        <html>
          <body>
            <script>alert("안건정보가 없습니다."); history.back();</script>
          </body>
        </html>
      `);

      await expect(
        service.captureNsmDetailFull('2219887'),
      ).rejects.toBeInstanceOf(NsmWaitingroomUnresolvedError);
    });

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

  describe('probeNsmDeletedBillAlert', () => {
    afterEach(() => {
      mockFetchHtmlPage.mockReset();
      delete process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED;
    });

    it('confirms deletion when the fetched detail page has the alert and no core structure', async () => {
      mockFetchHtmlPage.mockResolvedValue({
        data: `
          <html>
            <head><title>안건정보</title></head>
            <body>
              <script>alert("안건정보가 없습니다."); history.back();</script>
            </body>
          </html>
        `,
      } as any);

      const result = await service.probeNsmDeletedBillAlert('2219887');

      expect(result).toBe('안건정보가 없습니다.');
    });

    it('does not confirm deletion when the fetch lands on an unresolved Waitingroom page, even if the alert text happens to appear', async () => {
      mockFetchHtmlPage.mockResolvedValue({
        data: `
          <html>
            <head><title>Waitingroom</title></head>
            <body>
              <script>alert("안건정보가 없습니다."); history.back();</script>
            </body>
          </html>
        `,
      } as any);

      const result = await service.probeNsmDeletedBillAlert('2219887');

      expect(result).toBeNull();
    });

    it('returns null when the HTTP fetch throws', async () => {
      mockFetchHtmlPage.mockRejectedValue(new Error('network error'));

      const result = await service.probeNsmDeletedBillAlert('2219887');

      expect(result).toBeNull();
    });

    it('returns null without issuing a request when deletion detection is disabled at runtime', async () => {
      process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'false';

      const result = await service.probeNsmDeletedBillAlert('2219887');

      expect(result).toBeNull();
      expect(mockFetchHtmlPage).not.toHaveBeenCalled();
    });
  });

  describe('probeNsmDeletedBillOutcome', () => {
    const detailPageHtml = `
      <html><head><title>법률안 상세</title></head>
      <body>
        <div id="containerWrap">
          <p class="subjectHead_tit">학교체육 진흥법 일부개정법률안</p>
          <table class="gridCnt_table"><tbody><tr><td>제안이유</td></tr></tbody></table>
          <form name="VIEW_FM"></form>
        </div>
      </body></html>
    `;

    afterEach(() => {
      mockFetchHtmlPage.mockReset();
      delete process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED;
      delete process.env.CRAWLING_NSM_ENABLED;
    });

    it('reports a confirmed deletion as `deleted` with the alert message', async () => {
      mockFetchHtmlPage.mockResolvedValue({
        data: `<html><head><title>안건정보</title></head>
          <body><script>alert("안건정보가 없습니다."); history.back();</script></body></html>`,
      } as any);

      await expect(
        service.probeNsmDeletedBillOutcome('2219887'),
      ).resolves.toEqual({
        outcome: 'deleted',
        alertMessage: '안건정보가 없습니다.',
      });
    });

    it('reports a readable, live detail page as `alive`', async () => {
      mockFetchHtmlPage.mockResolvedValue({ data: detailPageHtml } as any);

      await expect(
        service.probeNsmDeletedBillOutcome('2219887'),
      ).resolves.toEqual({ outcome: 'alive', alertMessage: null });
    });

    it('probes the detail page with a coherent browser identity', async () => {
      mockFetchHtmlPage.mockResolvedValue({ data: detailPageHtml } as any);

      await service.probeNsmDeletedBillOutcome('2219887');

      expect(mockFetchHtmlPage).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetchHtmlPage.mock.calls[0];
      expect(url).toBe(
        'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219887/detailRP',
      );
      expectBrowserFetchHeaders(
        options as {
          userAgent: string;
          customHeaders: Record<string, string>;
        },
      );
    });

    it('reports the portal error page as `blocked` instead of a live bill', async () => {
      // The portal answers refused requests (for example a blacklisted
      // User-Agent) with HTTP 200 and this shell page. Reading it as `alive`
      // would hide the block and keep every candidate re-probed forever.
      mockFetchHtmlPage.mockResolvedValue({
        data: `<html><head><title>국민참여입법센터</title></head>
          <body class="errorWrap"><section class="errorPanel">
          <button onclick="location.href='/'">메인화면으로 이동</button>
          <button onclick="history.back()">이전화면으로 이동</button>
          </section></body></html>`,
      } as any);

      await expect(
        service.probeNsmDeletedBillOutcome('2219887'),
      ).resolves.toEqual({ outcome: 'blocked', alertMessage: null });
    });

    it('reports an unresolved Waitingroom as `blocked`, not as a live bill', async () => {
      mockFetchHtmlPage.mockResolvedValue({
        data: `<html><head><title>Waitingroom</title></head><body>대기중</body></html>`,
      } as any);

      await expect(
        service.probeNsmDeletedBillOutcome('2219887'),
      ).resolves.toEqual({ outcome: 'blocked', alertMessage: null });
    });

    it('reports a failed request as `error`', async () => {
      mockFetchHtmlPage.mockRejectedValue(new Error('network error'));

      await expect(
        service.probeNsmDeletedBillOutcome('2219887'),
      ).resolves.toEqual({ outcome: 'error', alertMessage: null });
    });

    it('reports `disabled` without issuing a request when deletion detection is off', async () => {
      process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'false';

      await expect(
        service.probeNsmDeletedBillOutcome('2219887'),
      ).resolves.toEqual({ outcome: 'disabled', alertMessage: null });
      expect(mockFetchHtmlPage).not.toHaveBeenCalled();
    });

    it('keeps the alert-only wrapper returning null for a blocked response', async () => {
      mockFetchHtmlPage.mockResolvedValue({
        data: '<html><body class="errorWrap">요청페이지가 없습니다.</body></html>',
      } as any);

      await expect(
        service.probeNsmDeletedBillAlert('2219887'),
      ).resolves.toBeNull();
    });
  });

  describe('crawler activation guards', () => {
    afterEach(() => {
      delete process.env.CRAWLING_PAL_ENABLED;
      delete process.env.CRAWLING_NSM_ENABLED;
      delete process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED;
    });

    it('yields no PAL pages and never creates a PAL client when disabled', async () => {
      process.env.CRAWLING_PAL_ENABLED = 'false';
      (mockPalCrawl as any).getAllPages = jest.fn().mockReturnValue(
        (async function* () {
          yield { items: mockTableData, currentPage: 1, totalPages: 1 };
        })(),
      );

      const pages: unknown[] = [];
      for await (const page of service.getAllPages()) {
        pages.push(page);
      }

      expect(pages).toEqual([]);
      expect((mockPalCrawl as any).getAllPages).not.toHaveBeenCalled();
    });

    it('yields PAL pages when the PAL crawler is enabled (default)', async () => {
      (mockPalCrawl as any).getAllPages = jest.fn().mockReturnValue(
        (async function* () {
          yield { items: mockTableData, currentPage: 1, totalPages: 1 };
        })(),
      );

      const pages: unknown[] = [];
      for await (const page of service.getAllPages()) {
        pages.push(page);
      }

      expect(pages).toHaveLength(1);
    });

    it('yields no NSM list or pending pages when disabled', async () => {
      process.env.CRAWLING_NSM_ENABLED = 'false';
      (mockNsmLmSts as any).getAllPages = jest.fn().mockReturnValue(
        (async function* () {
          yield { items: [], currentPage: 1, totalPages: 1 };
        })(),
      );

      const allPages: unknown[] = [];
      for await (const page of service.getAllNsmPages()) {
        allPages.push(page);
      }

      const pendingPages: unknown[] = [];
      for await (const page of service.getAllNsmPendingPages()) {
        pendingPages.push(page);
      }

      expect(allPages).toEqual([]);
      expect(pendingPages).toEqual([]);
      expect((mockNsmLmSts as any).getAllPages).not.toHaveBeenCalled();
    });

    it('skips the NSM deletion probe when the NSM crawler is disabled', async () => {
      process.env.CRAWLING_NSM_ENABLED = 'false';
      mockFetchHtmlPage.mockResolvedValue({ data: '<html></html>' } as any);

      await expect(
        service.probeNsmDeletedBillAlert('2219776'),
      ).resolves.toBeNull();
      expect(mockFetchHtmlPage).not.toHaveBeenCalled();
    });
  });

  describe('NSM source selection (CRAWLING_NSM_SOURCE)', () => {
    beforeEach(() => {
      // Isolate from other specs in this file that toggle the enable flags.
      delete process.env.CRAWLING_NSM_ENABLED;
      delete process.env.CRAWLING_NSM_SOURCE;
    });

    afterEach(() => {
      delete process.env.CRAWLING_NSM_SOURCE;
    });

    it('uses NsmLmSts for NSM list, pending and detail by default', async () => {
      (mockNsmLmSts as any).getAllPages = jest.fn().mockReturnValue(
        (async function* () {
          yield { items: [], currentPage: 1, totalPages: 1 };
        })(),
      );
      (mockNsmLmSts as any).getAllPendingPages = jest.fn().mockReturnValue(
        (async function* () {
          yield { items: [], currentPage: 1, totalPages: 1 };
        })(),
      );

      for await (const _page of service.getAllNsmPages()) {
        // Drain the empty stream.
      }

      expect(NsmLmSts).toHaveBeenCalled();
      expect(LikmsNsmAdapter).not.toHaveBeenCalled();
    });

    it('routes list, pending and detail crawls through LikmsNsmAdapter when CRAWLING_NSM_SOURCE=likms', async () => {
      process.env.CRAWLING_NSM_SOURCE = 'likms';

      const likmsItem = {
        billName: '계류 법안',
        billNo: '2221883',
        link: 'https://likms.assembly.go.kr/bill/billDetail.do?billId=PRC_X1',
        proposer: '홍길동의원',
        proposalDate: '2026-10-13',
        committee: '법제사법위원회',
        ministry: '',
        progressStatus: '접수',
        progressDate: '',
        resolutionStatus: '',
        resolutionDate: '',
      };

      mockLikmsAdapter.getAllPages.mockReturnValue(
        (async function* () {
          yield { items: [likmsItem], currentPage: 1, totalPages: 1 };
        })(),
      );
      mockLikmsAdapter.getAllPendingPages.mockReturnValue(
        (async function* () {
          yield { items: [likmsItem], currentPage: 1, totalPages: 1 };
        })(),
      );

      const allPages: unknown[] = [];
      for await (const page of service.getAllNsmPages()) {
        allPages.push(page);
      }

      const pendingPages: unknown[] = [];
      for await (const page of service.getAllNsmPendingPages()) {
        pendingPages.push(page);
      }

      const detail = await service.getNsmDetail('2221883');

      expect(allPages).toHaveLength(1);
      expect(pendingPages).toHaveLength(1);
      expect(detail).toEqual({ proposalReason: 'reason' });
      expect(NsmLmSts).not.toHaveBeenCalled();

      const likmsConfig = (
        LikmsNsmAdapter as jest.MockedClass<typeof LikmsNsmAdapter>
      ).mock.calls[0][0];
      expectBrowserClientConfig(likmsConfig);
      expect(likmsConfig).toEqual(
        expect.objectContaining({ timeout: 15000, retryCount: 3 }),
      );
      // Bulk scans must not hydrate per-item proposal reasons (2 extra requests each).
      expect(likmsConfig).not.toHaveProperty('hydrateProposalReason');
    });

    it('captures likms detail from the 의안정보시스템 page and reads its fields from the adapter', async () => {
      process.env.CRAWLING_NSM_SOURCE = 'likms';
      mockLikmsCrawler.resolveBillId.mockResolvedValue('PRC_X1');
      mockLikmsAdapter.getDetail.mockResolvedValue({
        proposalReason: 'likms 제안이유',
        billNo: '2221883',
      });
      mockPage.content.mockResolvedValue('<html>likms detail</html>');
      mockPage.url.mockReturnValue(
        'https://likms.assembly.go.kr/bill/bi/billDetailPage.do?billId=PRC_X1&currMenuNo=2600044',
      );

      const result = await service.captureNsmDetailFull('2221883');

      // The snapshot is the page that listed the bill, not the NSM portal.
      expect(mockPage.goto).toHaveBeenCalledWith(
        expect.stringContaining(
          'https://likms.assembly.go.kr/bill/bi/billDetailPage.do',
        ),
        expect.anything(),
      );
      expect(mockPage.goto).toHaveBeenCalledWith(
        expect.stringContaining('billId=PRC_X1'),
        expect.anything(),
      );
      expect(mockPage.goto).not.toHaveBeenCalledWith(
        expect.stringContaining('opinion.lawmaking.go.kr'),
        expect.anything(),
      );
      expect(result.responseUrl).toContain('likms.assembly.go.kr');
      expect(result.html).toBe('<html>likms detail</html>');
      expect(result.detail).toEqual({
        proposalReason: 'likms 제안이유',
        billNo: '2221883',
      });
      expect(mockLikmsAdapter.getDetail).toHaveBeenCalledWith('2221883');
      // NSM-only parsing and its deletion heuristic must not touch a likms page.
      expect(mockNsmLmStsParser.parseDetail).not.toHaveBeenCalled();
    });

    it('fails loudly when likms has no detail page for the bill', async () => {
      process.env.CRAWLING_NSM_SOURCE = 'likms';
      mockLikmsCrawler.resolveBillId.mockResolvedValue(null);

      await expect(service.captureNsmDetailFull('2299999')).rejects.toThrow(
        'likms has no detail page for bill 2299999',
      );
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it('backfills the screenshot from the likms page when that source is active', async () => {
      process.env.CRAWLING_NSM_SOURCE = 'likms';
      mockLikmsCrawler.resolveBillId.mockResolvedValue('PRC_X1');

      const screenshot = await service.captureNsmDetailScreenshot('2221883');

      expect(mockPage.goto).toHaveBeenCalledWith(
        expect.stringContaining(
          'likms.assembly.go.kr/bill/bi/billDetailPage.do',
        ),
        expect.anything(),
      );
      expect(screenshot).toEqual(Buffer.from('jpeg'));
      // The NSM-only screenshot getter must not be used for a likms bill.
      expect(mockNsmLmSts.getDetailScreenshot).not.toHaveBeenCalled();
    });

    it('maps adapter items into the same CachedNotice shape as NSM items', () => {
      const notice = CrawlingCoreService.nsmBillToCachedNotice({
        billName: '계류 법안',
        billNo: '2221883',
        link: 'https://likms.assembly.go.kr/bill/billDetail.do?billId=PRC_X1',
        proposer: '홍길동의원',
        proposalDate: '2026-10-13',
        committee: '법제사법위원회',
        ministry: '',
        progressStatus: '접수',
        progressDate: '',
        resolutionStatus: '',
        resolutionDate: '',
      });

      expect(notice.num).toBe(2221883);
      expect(notice.subject).toBe('계류 법안');
      expect(notice.proposerCategory).toBe('의원');
      expect(notice.committee).toBe('법제사법위원회');
      expect(notice.contentId).toBeNull();
    });
  });

  describe('NSM item classification for the pipeline', () => {
    const baseItem = {
      billName: '계류 법안',
      link: 'https://example.com',
      proposer: '홍길동의원',
      proposalDate: '2026-10-13',
      committee: '',
      ministry: '',
      progressStatus: '접수',
      progressDate: '',
      resolutionStatus: '',
      resolutionDate: '',
    };

    it('treats both NSM `발의` and LIKMS `접수` as pending-like', () => {
      expect(CrawlingCoreService.isPendingProgressStatus('발의')).toBe(true);
      expect(CrawlingCoreService.isPendingProgressStatus('접수')).toBe(true);
      expect(CrawlingCoreService.isPendingProgressStatus(' 접수 ')).toBe(true);
      expect(CrawlingCoreService.isPendingProgressStatus('위원회 회부')).toBe(
        false,
      );
      expect(CrawlingCoreService.isPendingProgressStatus('소관위접수')).toBe(
        false,
      );
      expect(CrawlingCoreService.isPendingProgressStatus(null)).toBe(false);
      expect(CrawlingCoreService.isPendingProgressStatus(undefined)).toBe(
        false,
      );
    });

    it('accepts numeric bill numbers and rejects LIKMS non-bill ids', () => {
      expect(
        CrawlingCoreService.isCrawlableNsmBill({
          ...baseItem,
          billNo: '2221883',
        }),
      ).toBe(true);
      expect(
        CrawlingCoreService.isCrawlableNsmBill({
          ...baseItem,
          billNo: ' 2221883 ',
        }),
      ).toBe(true);
      expect(
        CrawlingCoreService.isCrawlableNsmBill({
          ...baseItem,
          billNo: 'ZZ22142',
        }),
      ).toBe(false);
      expect(
        CrawlingCoreService.isCrawlableNsmBill({ ...baseItem, billNo: '' }),
      ).toBe(false);
      expect(
        CrawlingCoreService.isCrawlableNsmBill({ ...baseItem, billNo: '0' }),
      ).toBe(false);
    });
  });
});
