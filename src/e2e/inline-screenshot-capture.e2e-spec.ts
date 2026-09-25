/**
 * Real-surface e2e for the inline PAL screenshot capture.
 *
 * The unit and integration specs stub `CrawlingCoreService`, so they never
 * prove that a real browser capture behaves the same way. This spec drives the
 * real stack end to end: real Chromium launch via `BrowserLeaseManagerService`,
 * a real navigation, a real JPEG encode, the real sharp size-reduction branch,
 * and the real SQLite write performed by `ArchiveOrchestratorService.archiveNotices`.
 *
 * The upstream site is never contacted. `pal-crawl`'s exported `Config` is
 * pointed at a loopback HTTP server for the duration of this suite, so the
 * browser still performs a genuine navigation while the run stays hermetic and
 * bounded to two captures: one success and one real navigation failure.
 *
 * Opt in with RUN_SNAPSHOT_BROWSER_E2E=true (the RUN_*_E2E convention used by
 * the other live e2e specs). It requires a locally installed Chromium.
 */
import * as http from 'node:http';
import { type AddressInfo } from 'node:net';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import { Config } from 'pal-crawl';
import { APP_CONSTANTS } from '../config/app.config';
import { AllowSnapshotArtifactFirstFill1755043201000 } from '../migrations/202608130001-allow-snapshot-artifact-first-fill.migration';
import { BrowserLeaseManagerService } from '../modules/crawling/browser-lease-manager.service';
import { ArchiveOrchestratorService } from '../modules/crawling/archive-orchestrator.service';
import { CrawlingCoreService } from '../modules/crawling/crawling-core.service';
import { NoticeArchive } from '../modules/notice/notice-archive.entity';
import { NoticeArchiveIntegrityCheck } from '../modules/notice/notice-archive-integrity-check.entity';
import { NoticeArchiveIntegrityState } from '../modules/notice/notice-archive-integrity-state.entity';
import { NoticeArchiveService } from '../modules/notice/notice-archive.service';
import { NoticeArchiveSnapshotState } from '../modules/notice/notice-archive-summary-state.entity';
import { type CachedNotice } from '../types/cache.types';
import { LoggerUtils } from '../utils/logger.utils';

const runBrowserE2E = process.env.RUN_SNAPSHOT_BROWSER_E2E === 'true';
const itIfBrowser = runBrowserE2E ? it : it.skip;

/**
 * pal-crawl declares `Config` as a const enum, so the members are typed
 * read-only even though the runtime object is mutable and is re-read on every
 * URL build. Writing through this view redirects the real browser without
 * touching any pal-crawl code.
 */
const palConfig = Config as unknown as { DOMAIN: string };

const setPalDomain = (domain: string): void => {
  palConfig.DOMAIN = domain;
};

/** Path pal-crawl builds for a PAL content page (Config.CONTENT_URL). */
const PAL_CONTENT_PATH = '/napal/lgsltpa/lgsltpaOngoing/view.do';

/** Served document: tall enough that a full-page capture exceeds the viewport. */
const CONTENT_PAGE_MARKER = 'PAL-E2E-CONTENT-MARKER';
const SOURCE_PAGE_MARKER = 'PAL-E2E-SOURCE-MARKER';

const contentPageHtml = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>입법예고 e2e</title></head><body>
<h1>${CONTENT_PAGE_MARKER}</h1>
<p>제안 이유: 실제 브라우저 캡처 검증용 페이지입니다.</p>
<div style="height:2600px;background:linear-gradient(#fff,#333)"></div>
<div style="height:200px;background:#123456"></div>
</body></html>`;

/**
 * Solid 200px band at the very bottom of the served page. Sampling it in the
 * stored image proves the image is a render of this document (a blank or error
 * page would have neither the height nor this colour).
 */
const BOTTOM_BAND_RGB = [0x12, 0x34, 0x56] as const;
const BOTTOM_BAND_TOLERANCE = 12;

const sourcePageHtml = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>source</title></head><body><p>${SOURCE_PAGE_MARKER}</p></body></html>`;

/** A notice whose link points at the loopback source page. */
const makeNotice = (num: number, baseUrl: string): CachedNotice => ({
  num,
  subject: `e2e 법률안 ${num}`,
  proposerCategory: '정부',
  committee: '법제사법위원회',
  link: `${baseUrl}/notice/${num}`,
  contentId: `e2e-content-${num}`,
  attachments: { pdfFile: '', hwpFile: '' },
  aiSummary: null,
  aiSummaryStatus: 'not_requested',
});

describe('Inline PAL screenshot capture (real browser e2e)', () => {
  let server: http.Server;
  let baseUrl = '';
  let originalDomain = palConfig.DOMAIN;
  let requestLog: Array<{ path: string; dest: string | undefined }> = [];

  let dataSource: DataSource;
  let noticeArchiveService: NoticeArchiveService;
  let service: ArchiveOrchestratorService;
  let leaseManager: BrowserLeaseManagerService;
  let loggerWarnSpy: jest.SpyInstance;

  /** Browser navigations (document requests) seen by the loopback server. */
  const documentNavigations = (path: string): number =>
    requestLog.filter(
      (entry) => entry.path === path && entry.dest === 'document',
    ).length;

  const requestsTo = (path: string): number =>
    requestLog.filter((entry) => entry.path === path).length;

  /**
   * A loopback URL nothing is listening on, so a real navigation fails at the
   * connection layer (net::ERR_CONNECTION_REFUSED). Chromium treats very low
   * ports as unsafe and short-circuits them before any connection attempt, so
   * the port is reserved and released rather than hard-coded.
   */
  const closedLoopbackUrl = async (): Promise<string> => {
    const probe = http.createServer();
    await new Promise<void>((resolve) =>
      probe.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
  };

  const createChangeTrackingMock = () => ({
    getCompleteNoticeChangeTimeline: jest.fn().mockResolvedValue([]),
    buildDiffEvent: jest.fn().mockReturnValue({ shouldAppend: false }),
    beginChangeNotificationCollection: jest.fn(),
    endChangeNotificationCollection: jest.fn().mockResolvedValue(undefined),
    beginChangeNotificationSuppression: jest.fn(),
    endChangeNotificationSuppression: jest.fn(),
    flushQueuedChangeNotificationsNow: jest.fn().mockResolvedValue(undefined),
  });

  beforeAll(async () => {
    if (!runBrowserE2E) {
      return;
    }

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requestLog.push({
        path: url.pathname,
        dest: req.headers['sec-fetch-dest'] as string | undefined,
      });

      if (url.pathname === PAL_CONTENT_PATH) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(contentPageHtml);
        return;
      }

      if (url.pathname.startsWith('/notice/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(sourcePageHtml);
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Point the real browser path at the loopback server for this suite.
    setPalDomain(baseUrl);

    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [
        NoticeArchive,
        NoticeArchiveSnapshotState,
        NoticeArchiveIntegrityCheck,
        NoticeArchiveIntegrityState,
      ],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    const queryRunner = dataSource.createQueryRunner();
    await new AllowSnapshotArtifactFirstFill1755043201000().up(queryRunner);
    await queryRunner.release();
  });

  afterAll(async () => {
    if (!runBrowserE2E) {
      return;
    }

    setPalDomain(originalDomain);
    await dataSource?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    if (!runBrowserE2E) {
      return;
    }

    requestLog = [];
    await dataSource.getRepository(NoticeArchive).clear();
    await dataSource.getRepository(NoticeArchiveSnapshotState).clear();
    await dataSource.getRepository(NoticeArchiveIntegrityCheck).clear();
    await dataSource.getRepository(NoticeArchiveIntegrityState).clear();

    noticeArchiveService = new NoticeArchiveService(
      dataSource.getRepository(NoticeArchive),
      dataSource.getRepository(NoticeArchiveSnapshotState),
      createChangeTrackingMock() as never,
      { logEvent: jest.fn() } as never,
      dataSource.getRepository(NoticeArchiveIntegrityCheck),
      dataSource.getRepository(NoticeArchiveIntegrityState),
    );

    leaseManager = new BrowserLeaseManagerService();
    const crawlingCoreService = new CrawlingCoreService(leaseManager);

    service = new ArchiveOrchestratorService(
      {
        getObject: jest.fn().mockResolvedValue(null),
        setObject: jest.fn().mockResolvedValue(true),
        deleteKey: jest.fn().mockResolvedValue(true),
      } as never,
      noticeArchiveService,
      crawlingCoreService,
      { logEvent: jest.fn() } as never,
    );

    loggerWarnSpy = jest
      .spyOn(
        LoggerUtils.getContextLogger(ArchiveOrchestratorService.name),
        'warn',
      )
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (!runBrowserE2E) {
      return;
    }

    loggerWarnSpy.mockRestore();
    // Let Chromium exit before the next case reuses the loopback server.
    await leaseManager.waitForIdle(20_000);
    await leaseManager.onApplicationShutdown('e2e');
  });

  itIfBrowser(
    'captures and stores a real browser screenshot in the same upsert as the snapshot',
    async () => {
      const notice = makeNotice(900001, baseUrl);

      const saved = await service.archiveNotices([notice]);
      expect(saved).toBe(1);

      const row = await dataSource
        .getRepository(NoticeArchive)
        .findOneByOrFail({ noticeNum: notice.num });

      // Source snapshot from the loopback page, captured by the real HTTP path.
      expect(row.sourceHtml).toContain(SOURCE_PAGE_MARKER);

      // The image is a real browser render of the served document.
      const blob = row.screenshotBlob as Buffer;
      expect(Buffer.isBuffer(blob)).toBe(true);
      expect(blob.subarray(0, 2).toString('hex')).toBe('ffd8'); // JPEG SOI
      expect(blob.length).toBeLessThanOrEqual(
        APP_CONSTANTS.SCREENSHOT.MAX_SIZE_BYTES,
      );

      const metadata = await sharp(blob).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.width).toBe(APP_CONSTANTS.SCREENSHOT.WIDTH);
      // Taller than the viewport: proves a full-page capture of the page.
      expect(metadata.height ?? 0).toBeGreaterThan(
        APP_CONSTANTS.SCREENSHOT.HEIGHT,
      );

      // Pixel at the bottom band of the served document, so the stored image is
      // demonstrably a render of that page and not of a blank/error document.
      const { data, info } = await sharp(blob)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const offset = ((info.height - 20) * info.width + 10) * info.channels;
      const sampledRgb = [data[offset], data[offset + 1], data[offset + 2]];
      sampledRgb.forEach((channel, index) => {
        expect(Math.abs(channel - BOTTOM_BAND_RGB[index])).toBeLessThanOrEqual(
          BOTTOM_BAND_TOLERANCE,
        );
      });

      expect(row.screenshotFormat).toBe('jpeg');
      // NULL status with a blob means the image came from the INSERT itself;
      // any later guarded fill (backfill/drain) would have stamped 'captured'.
      expect(row.screenshotCaptureStatus).toBeNull();

      // Exactly one browser navigation: no duplicate capture on this path.
      expect(documentNavigations(PAL_CONTENT_PATH)).toBe(1);
      expect(requestsTo(`/notice/${notice.num}`)).toBe(1);
      expect(loggerWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Inline screenshot capture failed'),
      );

      const retryable =
        await noticeArchiveService.getNoticesWithMissingScreenshots(10);
      expect(retryable.map((item) => item.num)).not.toContain(notice.num);
    },
    120_000,
  );

  itIfBrowser(
    'records the failure when the real browser navigation fails',
    async () => {
      const notice = makeNotice(900002, baseUrl);
      // Closed port: the browser attempt is refused, so this exercises the
      // real net::ERR_CONNECTION_REFUSED path rather than a stub.
      setPalDomain(await closedLoopbackUrl());

      try {
        const saved = await service.archiveNotices([notice]);
        // The capture failure must not fail the archive itself.
        expect(saved).toBe(1);

        const row = await dataSource
          .getRepository(NoticeArchive)
          .findOneByOrFail({ noticeNum: notice.num });

        expect(row.sourceHtml).toContain(SOURCE_PAGE_MARKER);
        expect(row.screenshotBlob).toBeNull();
        expect(row.screenshotFormat).toBeNull();
        expect(row.screenshotCaptureStatus).toBe('failed');
        expect(row.screenshotCaptureError).toContain('browser_error');
        expect(row.screenshotCaptureError).toContain(
          'net::ERR_CONNECTION_REFUSED',
        );

        expect(loggerWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            `Inline screenshot capture failed for notice ${notice.num}`,
          ),
        );

        // The browser never reached the loopback server on this attempt.
        expect(documentNavigations(PAL_CONTENT_PATH)).toBe(0);
        expect(requestsTo(PAL_CONTENT_PATH)).toBe(0);

        const retryable =
          await noticeArchiveService.getNoticesWithMissingScreenshots(10);
        expect(retryable.map((item) => item.num)).toContain(notice.num);
      } finally {
        setPalDomain(baseUrl);
      }
    },
    120_000,
  );
});
