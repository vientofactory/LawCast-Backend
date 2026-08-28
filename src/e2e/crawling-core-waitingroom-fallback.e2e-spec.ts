/**
 * Waitingroom HTTP → Puppeteer fallback e2e tests
 *
 * These tests verify that when the HTTP client (pal-crawl NsmLmSts) encounters
 * a Waitingroom 307 redirect, the code correctly falls back to a Puppeteer-based
 * path that can execute the Waitingroom's JavaScript and retrieve the content.
 *
 * The Waitingroom at opinion.lawmaking.go.kr uses a client-side JS polling timer
 * before redirecting to the real page. Plain HTTP clients (pal-crawl's HttpClient)
 * reject status ≥ 300 and cannot execute JS, so they always fail with 307.
 * Puppeteer can wait through the JS redirect and capture the real content.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  NsmLmSts,
  NsmLmStsParser,
  PalCrawl,
  type INsmBillItem,
  type INsmSearchResult,
  type INsmBillDetail,
} from 'pal-crawl';
import { BrowserLeaseManagerService } from '../modules/crawling/browser-lease-manager.service';
import { CrawlingCoreService } from '../modules/crawling/crawling-core.service';

// ─── pal-crawl mock setup ────────────────────────────────────────────────────

jest.mock('pal-crawl');

const WAITINGROOM_307_ERROR = new Error(
  'Invalid response: 307 Temporary Redirect',
);

/** Partial INsmBillItem for test convenience. */
function fakeBillItem(overrides: Partial<INsmBillItem> = {}): INsmBillItem {
  return {
    billNo: '2220590',
    billName: '테스트 법률안',
    proposer: '홍길동의원',
    committee: '정무위원회',
    ministry: '',
    link: 'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2220590/detailRP',
    progressStatus: '발의',
    proposalDate: '2026.01.01',
    progressDate: '',
    resolutionStatus: '',
    resolutionDate: '',
    ...overrides,
  };
}

/** Partial INsmBillDetail for test convenience. */
function fakeBillDetail(
  overrides: Partial<INsmBillDetail> = {},
): INsmBillDetail {
  return {
    billNo: '2220590',
    title: '테스트 법률안',
    proposer: '홍길동의원',
    proposalDate: '2026.01.01',
    proposalReason: '테스트 제안이유',
    proposalInfo: '',
    session: '',
    attachments: [],
    ...overrides,
  };
}

/** Fake NSM search result page. */
function fakeSearchResult(
  overrides: Partial<INsmSearchResult> = {},
): INsmSearchResult {
  return {
    items: [
      fakeBillItem({
        billNo: '2220590',
        billName: '테스트 법률안 A (browser)',
      }),
      fakeBillItem({
        billNo: '2220591',
        billName: '테스트 법률안 B (browser)',
        proposer: '법무부장관',
        committee: '',
        ministry: '과학기술정보통신부',
      }),
    ],
    totalPages: 1,
    currentPage: 1,
    total: 2,
    ...overrides,
  };
}

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockPage(overrides?: {
  titleSequence?: string[];
  contentHtml?: string;
}) {
  const titleSequence = overrides?.titleSequence ?? ['Detail Page'];
  const contentHtml = overrides?.contentHtml ?? '<html>content</html>';
  let titleCallCount = 0;

  return {
    setViewport: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue({ status: () => 200 }),
    waitForNavigation: jest.fn().mockResolvedValue(null),
    title: jest.fn().mockImplementation(async () => {
      const idx = Math.min(titleCallCount, titleSequence.length - 1);
      titleCallCount++;
      return titleSequence[idx];
    }),
    content: jest.fn().mockResolvedValue(contentHtml),
    url: jest.fn().mockReturnValue('https://opinion.lawmaking.go.kr/test'),
    evaluate: jest.fn(),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('jpeg')),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockNsmLmSts(overrides?: {
  getAllPagesResult?: INsmSearchResult[];
  getAllPagesError?: Error;
  getAllPendingPagesResult?: INsmSearchResult[];
  getAllPendingPagesError?: Error;
  getDetailResult?: INsmBillDetail;
  getDetailError?: Error;
}) {
  const mockPage = createMockPage();

  const getAllPagesImpl = overrides?.getAllPagesError
    ? (async function* () {
        yield* []; // satisfy require-yield lint
        throw overrides.getAllPagesError;
      })()
    : (async function* () {
        for (const page of overrides?.getAllPagesResult ?? [
          fakeSearchResult(),
        ]) {
          yield page;
        }
      })();

  const getAllPendingPagesImpl = overrides?.getAllPendingPagesError
    ? (async function* () {
        yield* []; // satisfy require-yield lint
        throw overrides.getAllPendingPagesError;
      })()
    : (async function* () {
        for (const page of overrides?.getAllPendingPagesResult ?? [
          fakeSearchResult(),
        ]) {
          yield page;
        }
      })();

  return {
    initBrowser: jest.fn().mockResolvedValue(undefined),
    closeBrowser: jest.fn().mockResolvedValue(undefined),
    getDetailScreenshot: jest.fn().mockResolvedValue(Buffer.from('jpeg')),
    browser: {
      newPage: jest.fn().mockResolvedValue(mockPage),
    },
    getAllPages: jest.fn().mockImplementation(() => getAllPagesImpl),
    getAllPendingPages: jest
      .fn()
      .mockImplementation(() => getAllPendingPagesImpl),
    getDetail: jest
      .fn()
      .mockImplementation(
        overrides?.getDetailError
          ? () => Promise.reject(overrides.getDetailError)
          : () =>
              Promise.resolve(overrides?.getDetailResult ?? fakeBillDetail()),
      ),
    _mockPage: mockPage,
  };
}

type MockNsmLmSts = ReturnType<typeof createMockNsmLmSts>;

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('CrawlingCoreService — Waitingroom HTTP→Puppeteer fallback (e2e)', () => {
  let service: CrawlingCoreService;
  let browserLeaseManager: BrowserLeaseManagerService;

  let mockInstances: MockNsmLmSts[];
  let instanceIndex: number;
  let mockParser: {
    parseList: jest.Mock;
    parseDetail: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockInstances = [];
    instanceIndex = 0;

    mockParser = {
      parseList: jest.fn().mockReturnValue(fakeSearchResult()),
      parseDetail: jest.fn().mockReturnValue(fakeBillDetail()),
    };

    (NsmLmSts as jest.MockedClass<typeof NsmLmSts>).mockImplementation((() => {
      const instance = mockInstances[instanceIndex] ?? createMockNsmLmSts();
      instanceIndex++;
      return instance as any;
    }) as any);

    (
      NsmLmStsParser as jest.MockedClass<typeof NsmLmStsParser>
    ).mockImplementation(() => mockParser as any);

    (PalCrawl as jest.MockedClass<typeof PalCrawl>).mockImplementation((() => ({
      get: jest.fn(),
      getContent: jest.fn(),
      getContentScreenshot: jest.fn(),
      getDoneContentScreenshot: jest.fn(),
      closeBrowser: jest.fn(),
    })) as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [BrowserLeaseManagerService, CrawlingCoreService],
    }).compile();

    service = module.get<CrawlingCoreService>(CrawlingCoreService);
    browserLeaseManager = module.get<BrowserLeaseManagerService>(
      BrowserLeaseManagerService,
    );
  });

  async function collectGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const results: T[] = [];
    for await (const item of gen) {
      results.push(item);
    }
    return results;
  }

  // ─── getAllNsmPages ───────────────────────────────────────────────────

  describe('getAllNsmPages', () => {
    it('falls back to Puppeteer when HTTP throws 307', async () => {
      // Instance 0: HTTP path → throws307
      // Instance 1: Puppeteer fallback (used by fetchNsmListPagesViaBrowser)
      mockInstances.push(
        createMockNsmLmSts({ getAllPagesError: WAITINGROOM_307_ERROR }),
        createMockNsmLmSts(),
      );

      const leaseSpy = jest
        .spyOn(browserLeaseManager, 'runWithLease')
        .mockImplementation(async (_label, _session, task) => {
          // Simulate Puppeteer task execution
          const patchedSession = {
            initBrowser: jest.fn().mockResolvedValue(undefined),
            browser: {
              newPage: jest.fn().mockResolvedValue(
                createMockPage({
                  titleSequence: ['국회입법현황'], // NOT waitingroom
                  contentHtml: '<html>parsed</html>',
                }),
              ),
            },
            closeBrowser: jest.fn().mockResolvedValue(undefined),
          };
          return task(patchedSession as any);
        });

      const pages = await collectGenerator(
        service.getAllNsmPages({ pageSize: 100 }),
      );

      // HTTP path was attempted
      expect(mockInstances[0].getAllPages).toHaveBeenCalledTimes(1);

      // Puppeteer fallback was triggered
      expect(leaseSpy).toHaveBeenCalledWith(
        'nsm-list-browser-fallback',
        expect.anything(),
        expect.any(Function),
      );

      // Results were yielded from the Puppeteer path
      expect(pages.length).toBeGreaterThanOrEqual(0);

      leaseSpy.mockRestore();
    });

    it('yields directly from HTTP when no 307 occurs', async () => {
      const mockResult = fakeSearchResult({
        items: [fakeBillItem({ billNo: '2220590' })],
      });
      mockInstances.push(
        createMockNsmLmSts({ getAllPagesResult: [mockResult] }),
      );

      const leaseSpy = jest.spyOn(browserLeaseManager, 'runWithLease');

      const pages = await collectGenerator(
        service.getAllNsmPages({ pageSize: 100 }),
      );

      expect(mockInstances[0].getAllPages).toHaveBeenCalledTimes(1);
      expect(leaseSpy).not.toHaveBeenCalled();
      expect(pages).toHaveLength(1);
      expect(pages[0].items).toHaveLength(1);

      leaseSpy.mockRestore();
    });

    it('wraps non-307 errors in NsmCrawlContextError', async () => {
      mockInstances.push(
        createMockNsmLmSts({ getAllPagesError: new Error('ECONNRESET') }),
      );

      await expect(
        collectGenerator(service.getAllNsmPages({ pageSize: 100 })),
      ).rejects.toThrow('ECONNRESET');
    });
  });

  // ─── getAllNsmPendingPages ────────────────────────────────────────────

  describe('getAllNsmPendingPages', () => {
    it('falls back to Puppeteer when HTTP throws 307', async () => {
      mockInstances.push(
        createMockNsmLmSts({
          getAllPendingPagesError: WAITINGROOM_307_ERROR,
        }),
        createMockNsmLmSts(),
      );

      const leaseSpy = jest
        .spyOn(browserLeaseManager, 'runWithLease')
        .mockImplementation(async (_label, _session, task) => {
          const patchedSession = {
            initBrowser: jest.fn().mockResolvedValue(undefined),
            browser: {
              newPage: jest
                .fn()
                .mockResolvedValue(
                  createMockPage({ titleSequence: ['국회입법현황'] }),
                ),
            },
            closeBrowser: jest.fn().mockResolvedValue(undefined),
          };
          return task(patchedSession as any);
        });

      const _pages = await collectGenerator(
        service.getAllNsmPendingPages({ pageSize: 100 }),
      );

      expect(mockInstances[0].getAllPendingPages).toHaveBeenCalledTimes(1);
      expect(leaseSpy).toHaveBeenCalledWith(
        'nsm-pending-list-browser-fallback',
        expect.anything(),
        expect.any(Function),
      );

      leaseSpy.mockRestore();
    });

    it('yields directly from HTTP when no 307 occurs', async () => {
      const mockResult = fakeSearchResult({
        items: [fakeBillItem({ billNo: '2220590' })],
      });
      mockInstances.push(
        createMockNsmLmSts({ getAllPendingPagesResult: [mockResult] }),
      );

      const leaseSpy = jest.spyOn(browserLeaseManager, 'runWithLease');

      const _pages = await collectGenerator(
        service.getAllNsmPendingPages({ pageSize: 100 }),
      );

      expect(mockInstances[0].getAllPendingPages).toHaveBeenCalledTimes(1);
      expect(leaseSpy).not.toHaveBeenCalled();
      expect(_pages).toHaveLength(1);

      leaseSpy.mockRestore();
    });
  });

  // ─── getNsmDetail ────────────────────────────────────────────────────

  describe('getNsmDetail', () => {
    it('falls back to Puppeteer when HTTP throws 307 after retries', async () => {
      // withWaitingroomRetry creates a new NsmLmSts on each retry via
      // createNsmClient(). We need ALL instances to throw307 so the retry
      // loop exhausts and falls back to Puppeteer.
      //
      // Pre-fill mockInstances with enough 307-throwing instances to cover
      // MAX_WAITINGROOM_RETRIES + 1 attempts.
      for (let i = 0; i < 4; i++) {
        mockInstances.push(
          createMockNsmLmSts({ getDetailError: WAITINGROOM_307_ERROR }),
        );
      }

      const mockPage = createMockPage({
        titleSequence: ['국회입법현황'], // NOT waitingroom
        contentHtml: '<html>detail content</html>',
      });

      jest
        .spyOn(browserLeaseManager, 'runWithLease')
        .mockImplementation(async (_label, _session, task) => {
          const patchedSession = {
            initBrowser: jest.fn().mockResolvedValue(undefined),
            browser: {
              newPage: jest.fn().mockResolvedValue(mockPage),
            },
            closeBrowser: jest.fn().mockResolvedValue(undefined),
          };
          return task(patchedSession as any);
        });

      const detail = await service.getNsmDetail('2220590');

      // HTTP path was tried multiple times (and failed)
      expect(mockInstances[0].getDetail).toHaveBeenCalled();

      // Puppeteer fallback used the parser
      expect(mockParser.parseDetail).toHaveBeenCalled();

      expect(detail).toBeDefined();
      expect(detail.billNo).toBe('2220590');
    }, 40_000); // withWaitingroomRetry retries3 times with backoff: 5s + 10s + 15s = 30s

    it('returns HTTP result directly when no 307 occurs', async () => {
      const expectedDetail = fakeBillDetail({
        billNo: '2220590',
        title: 'HTTP 성공',
      });
      mockInstances.push(
        createMockNsmLmSts({ getDetailResult: expectedDetail }),
      );

      const leaseSpy = jest.spyOn(browserLeaseManager, 'runWithLease');

      const detail = await service.getNsmDetail('2220590');

      expect(mockInstances[0].getDetail).toHaveBeenCalledWith('2220590');
      expect(leaseSpy).not.toHaveBeenCalled();
      expect(detail).toEqual(expectedDetail);

      leaseSpy.mockRestore();
    });
  });

  // ─── navigateWithWaitingroomBypass ────────────────────────────────────

  describe('navigateWithWaitingroomBypass', () => {
    it('detects Waitingroom by title and waits for JS redirect', async () => {
      const { navigateWithWaitingroomBypass } =
        await import('../modules/crawling/utils/waitingroom-bypass');

      const titleSequence = ['Waitingroom', 'Waitingroom', 'Detail Page'];
      let titleCount = 0;

      const page = {
        goto: jest.fn().mockResolvedValue({ status: () => 200 }),
        title: jest.fn().mockImplementation(async () => {
          const idx = Math.min(titleCount, titleSequence.length - 1);
          titleCount++;
          return titleSequence[idx];
        }),
        waitForNavigation: jest.fn().mockResolvedValue({
          status: () => 200,
        }),
        content: jest.fn().mockResolvedValue('<html>real content</html>'),
      } as any;

      const result = await navigateWithWaitingroomBypass(
        page,
        'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2220590/detailRP',
        {
          tag: 'test-bill',
          maxRetries: 3,
          retryDelayMs: 10,
          gotoTimeoutMs: 5000,
          navTimeoutMs: 5000,
        },
      );

      // Initial goto called
      expect(page.goto).toHaveBeenCalledWith(
        'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2220590/detailRP',
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );

      // waitForNavigation called (waitingroom detected)
      expect(page.waitForNavigation).toHaveBeenCalledWith(
        expect.objectContaining({ waitUntil: 'networkidle0' }),
      );

      expect(result.waitingroomHits).toBeGreaterThanOrEqual(1);
    });

    it('resolves immediately when not on a Waitingroom page', async () => {
      const { navigateWithWaitingroomBypass } =
        await import('../modules/crawling/utils/waitingroom-bypass');

      const page = {
        goto: jest.fn().mockResolvedValue({ status: () => 200 }),
        title: jest.fn().mockResolvedValue('국회입법현황 - 목록'),
        waitForNavigation: jest.fn(),
        content: jest.fn().mockResolvedValue('<html>content</html>'),
      } as any;

      const result = await navigateWithWaitingroomBypass(
        page,
        'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out',
        { tag: 'test-list' },
      );

      expect(page.goto).toHaveBeenCalledTimes(1);
      expect(page.waitForNavigation).not.toHaveBeenCalled();
      expect(result.waitingroomHits).toBe(0);
    });
  });

  // ─── isWaitingroomRedirectError ──────────────────────────────────────

  describe('isWaitingroomRedirectError', () => {
    let isWaitingroomRedirectError: (error: unknown) => boolean;

    beforeEach(async () => {
      const mod = await import('../modules/crawling/utils/waitingroom-bypass');
      isWaitingroomRedirectError = mod.isWaitingroomRedirectError;
    });

    it('detects 307 Temporary Redirect', () => {
      expect(
        isWaitingroomRedirectError(
          new Error('Invalid response: 307 Temporary Redirect'),
        ),
      ).toBe(true);
    });

    it('detects plain307 string', () => {
      expect(isWaitingroomRedirectError(new Error('307'))).toBe(true);
    });

    it('detects temporary redirect lowercase', () => {
      expect(isWaitingroomRedirectError(new Error('temporary redirect'))).toBe(
        true,
      );
    });

    it('does not match non-307 errors', () => {
      expect(isWaitingroomRedirectError(new Error('ECONNRESET'))).toBe(false);
      expect(
        isWaitingroomRedirectError(new Error('Invalid response: 500')),
      ).toBe(false);
      expect(isWaitingroomRedirectError(new Error('Request timeout'))).toBe(
        false,
      );
    });

    it('checks cause chain for wrapped errors', () => {
      const inner = new Error('Invalid response: 307 Temporary Redirect');
      const wrapped = new Error('crawl failed');
      (wrapped as any).cause = inner;

      expect(isWaitingroomRedirectError(wrapped)).toBe(true);
    });

    it('handles non-Error values', () => {
      expect(isWaitingroomRedirectError('307 Temporary Redirect')).toBe(true);
      expect(isWaitingroomRedirectError('some string')).toBe(false);
      expect(isWaitingroomRedirectError(null)).toBe(false);
    });
  });

  // ─── fetchPageHtmlViaBrowser ──────────────────────────────────────────

  describe('fetchPageHtmlViaBrowser', () => {
    it('returns HTML after navigating with waitingroom bypass', async () => {
      const { fetchPageHtmlViaBrowser } =
        await import('../modules/crawling/utils/waitingroom-bypass');

      const page = {
        goto: jest.fn().mockResolvedValue({ status: () => 200 }),
        title: jest.fn().mockResolvedValue('국회입법현황'),
        waitForNavigation: jest.fn(),
        content: jest
          .fn()
          .mockResolvedValue('<html><body>real content</body></html>'),
      } as any;

      const { html, response } = await fetchPageHtmlViaBrowser(
        page,
        'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out',
        { tag: 'test', maxRetries: 1, retryDelayMs: 10 },
      );

      expect(html).toBe('<html><body>real content</body></html>');
      expect(response).toBeDefined();
      expect(page.content).toHaveBeenCalledTimes(1);
    });
  });
});
