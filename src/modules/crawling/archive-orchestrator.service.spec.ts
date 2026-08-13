import { Test, TestingModule } from '@nestjs/testing';
import {
  ArchiveOrchestratorService,
  ArchiveReason,
  NsmArchiveReason,
} from './archive-orchestrator.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import {
  CrawlingCoreService,
  NsmBillDeletedError,
} from './crawling-core.service';
import {
  SourceDeletionDetectedAs,
  SourceDeletionDetectionMethod,
} from './archive-detection-metadata.enum';
import { CacheService } from '../cache/cache.service';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { type CachedNotice } from '../../types/cache.types';
import { type INsmBillItem } from 'pal-crawl';
import { fetchHtmlPage } from '../../utils/http-fetch.utils';
import { computeSha256 } from '../notice/notice-archive.helpers';

jest.mock('../../utils/http-fetch.utils', () => ({
  fetchHtmlPage: jest.fn(),
}));

jest.mock('../../utils/async-delay.utils', () => ({
  delayMs: jest.fn().mockResolvedValue(undefined),
}));

const mockFetchHtmlPage = fetchHtmlPage as jest.MockedFunction<
  typeof fetchHtmlPage
>;

describe('ArchiveOrchestratorService', () => {
  let service: ArchiveOrchestratorService;
  let noticeArchiveService: NoticeArchiveService;
  let crawlingCoreService: CrawlingCoreService;
  let discordBridgeService: DiscordBridgeService;

  const mockNotice: CachedNotice = {
    num: 1,
    subject: '테스트 입법예고',
    proposerCategory: '정부',
    committee: '법제사법위원회',
    link: 'https://example.com/notice/1',
    contentId: 'content-1',
    attachments: { pdfFile: '', hwpFile: '' },
    aiSummary: 'AI 요약',
    aiSummaryStatus: 'ready',
  };

  const mockNoticeWithoutContentId: CachedNotice = {
    num: 2,
    subject: '컨텐츠 ID 없는 입법예고',
    proposerCategory: '의원',
    committee: '국정감사위원회',
    link: 'https://example.com/notice/2',
    contentId: null,
    attachments: { pdfFile: '', hwpFile: '' },
    aiSummary: null,
    aiSummaryStatus: 'not_supported',
  };

  const mockNsmBillItem = {
    billNo: '2219776',
    billName: '테스트 NSM 법률안',
    proposer: '홍길동의원',
    committee: '',
    ministry: '법무부',
    link: 'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219776/detailRP',
  } as INsmBillItem;

  beforeEach(async () => {
    const objectStore = new Map<string, unknown>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArchiveOrchestratorService,
        {
          provide: CacheService,
          useValue: {
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
          provide: NoticeArchiveService,
          useValue: {
            upsertNoticeArchive: jest.fn(),
            updateNsmHtmlAndDetail: jest.fn().mockResolvedValue(undefined),
            getLatestProposalReasonForNotice: jest.fn().mockResolvedValue(null),
            appendSourceDeletedEventByNoticeNum: jest
              .fn()
              .mockResolvedValue(undefined),
            getExistingNoticeNumSet: jest.fn(),
            beginChangeNotificationCollection: jest.fn(),
            endChangeNotificationCollection: jest
              .fn()
              .mockResolvedValue(undefined),
            flushQueuedChangeNotifications: jest
              .fn()
              .mockResolvedValue(undefined),
            updateScreenshot: jest.fn().mockResolvedValue(undefined),
            updateSourceHtml: jest.fn().mockResolvedValue(undefined),
            getNoticesWithMissingSnapshotArtifacts: jest
              .fn()
              .mockResolvedValue({ pal: [], nsm: [] }),
            getNoticesWithMissingScreenshots: jest.fn().mockResolvedValue([]),
            getNoticesWithMissingNsmScreenshots: jest
              .fn()
              .mockResolvedValue([]),
            getAllPalNoticesForScreenshotRequeue: jest
              .fn()
              .mockResolvedValue([]),
          },
        },
        {
          provide: CrawlingCoreService,
          useValue: {
            getContent: jest.fn(),
            captureNsmDetailFull: jest.fn(),
            probeNsmDeletedBillAlert: jest.fn().mockResolvedValue(null),
            captureContentScreenshot: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: DiscordBridgeService,
          useValue: {
            logEvent: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ArchiveOrchestratorService>(
      ArchiveOrchestratorService,
    );
    noticeArchiveService =
      module.get<NoticeArchiveService>(NoticeArchiveService);
    crawlingCoreService = module.get<CrawlingCoreService>(CrawlingCoreService);
    discordBridgeService =
      module.get<DiscordBridgeService>(DiscordBridgeService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('archiveNotices', () => {
    it('should return early for empty notices array', async () => {
      await service.archiveNotices([]);

      expect(noticeArchiveService.upsertNoticeArchive).not.toHaveBeenCalled();
      expect(crawlingCoreService.getContent).not.toHaveBeenCalled();
    });

    it('should archive notices with contentId successfully', async () => {
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

      const mockResponse = {
        data: '<html>Test HTML</html>',
        statusText: 'OK',
        config: { url: 'https://example.com/notice/1' },
        request: { res: { responseUrl: 'https://example.com/notice/1' } },
        status: 200,
        headers: {
          'content-type': 'text/html',
          etag: 'test-etag',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue(
        mockContent,
      );
      mockFetchHtmlPage.mockResolvedValue(mockResponse as any);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice]);

      expect(crawlingCoreService.getContent).toHaveBeenCalledWith('content-1');
      expect(mockFetchHtmlPage).toHaveBeenCalledWith(
        'https://example.com/notice/1',
        expect.objectContaining({
          userAgent: 'LawCast/1.0 (Legislative Notice Crawler)',
          timeoutMs: 15000,
        }),
      );
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        mockNotice,
        expect.objectContaining({
          proposalReason: 'Test Proposal Reason',
          title: 'Test Title',
          billNumber: 'Test Bill Number',
          proposer: 'Test Proposer',
          proposalDate: '2024-01-01',
          committee: 'Test Committee',
          referralDate: '2024-01-02',
          noticePeriod: 'Test Period',
          proposalSession: 'Test Session',
          sourceHtml: '<html>Test HTML</html>',
          htmlSha256: expect.any(String),
          archivedAt: expect.any(Date),
          httpMetadata: expect.objectContaining({
            requestUrl: 'https://example.com/notice/1',
            responseUrl: 'https://example.com/notice/1',
            statusCode: 200,
            contentType: 'text/html',
            etag: 'test-etag',
            lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
          }),
        }),
      );
    });

    it('should archive notices without contentId', async () => {
      const mockResponse = {
        data: '<html>Test HTML</html>',
        status: 200,
        statusText: 'OK',
        config: { url: 'https://example.com/notice/2' },
        request: { res: { responseUrl: 'https://example.com/notice/2' } },
        headers: {},
      };

      mockFetchHtmlPage.mockResolvedValue(mockResponse as any);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNoticeWithoutContentId]);

      expect(crawlingCoreService.getContent).not.toHaveBeenCalled();
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        mockNoticeWithoutContentId,
        expect.objectContaining({
          proposalReason: '',
          title: '컨텐츠 ID 없는 입법예고',
          billNumber: null,
          proposer: null,
          proposalDate: null,
          committee: null,
          referralDate: null,
          noticePeriod: null,
          proposalSession: null,
          sourceHtml: '<html>Test HTML</html>',
          htmlSha256: expect.any(String),
          archivedAt: expect.any(Date),
          httpMetadata: expect.objectContaining({
            requestUrl: 'https://example.com/notice/2',
            responseUrl: 'https://example.com/notice/2',
            statusCode: 200,
          }),
        }),
      );
    });

    it('should handle content fetch errors gracefully', async () => {
      const mockResponse = {
        data: '<html>Test HTML</html>',
        status: 200,
        statusText: 'OK',
        config: { url: 'https://example.com/notice/1' },
        request: { res: { responseUrl: 'https://example.com/notice/1' } },
        headers: {},
      };

      (crawlingCoreService.getContent as jest.Mock).mockRejectedValue(
        new Error('Content fetch failed'),
      );
      mockFetchHtmlPage.mockResolvedValue(mockResponse as any);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice]);

      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        mockNotice,
        expect.objectContaining({
          proposalReason: '',
          title: '테스트 입법예고',
        }),
      );
    });

    it('should handle HTML capture errors gracefully', async () => {
      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetchHtmlPage.mockRejectedValue(new Error('HTML capture failed'));
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice]);

      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        mockNotice,
        expect.objectContaining({
          proposalReason: 'Test Proposal Reason',
          title: 'Test Title',
          sourceHtml: null,
          htmlSha256: null,
          httpMetadata: null,
        }),
      );
    });

    it('should handle archive upsert errors gracefully', async () => {
      const mockResponse = {
        data: '<html>Test HTML</html>',
        status: 200,
        statusText: 'OK',
        config: { url: 'https://example.com/notice/1' },
        request: { res: { responseUrl: 'https://example.com/notice/1' } },
        headers: {},
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetchHtmlPage.mockResolvedValue(mockResponse as any);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockRejectedValue(
        new Error('Archive failed'),
      );

      await service.archiveNotices([mockNotice]);

      // Should not throw, just log the error
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalled();
    });

    it('should process notices in chunks with concurrency limit', async () => {
      const notices = Array.from({ length: 12 }, (_, i) => ({
        ...mockNotice,
        num: i + 1,
        link: `https://example.com/notice/${i + 1}`,
        contentId: `content-${i + 1}`,
      }));

      const mockResponse = {
        data: '<html>Test HTML</html>',
        status: 200,
        statusText: 'OK',
        config: { url: 'https://example.com/notice/1' },
        request: { res: { responseUrl: 'https://example.com/notice/1' } },
        headers: {},
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetchHtmlPage.mockResolvedValue(mockResponse as any);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices(notices);

      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledTimes(
        12,
      );
    });

    it('should log default archiving reason for new notices', async () => {
      const mockResponse = {
        data: '<html>Test HTML</html>',
        status: 200,
        statusText: 'OK',
        config: { url: 'https://example.com/notice/1' },
        request: { res: { responseUrl: 'https://example.com/notice/1' } },
        headers: {},
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetchHtmlPage.mockResolvedValue(mockResponse as any);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice]);

      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.LOG,
        'ArchiveOrchestratorService',
        'Archiving **1** notice(s)',
        expect.objectContaining({
          count: 1,
          reason: ArchiveReason.NEW_NOTICES,
        }),
      );
    });

    it('should log recompare reason with DEBUG level', async () => {
      const mockResponse = {
        data: '<html>Test HTML</html>',
        status: 200,
        statusText: 'OK',
        config: { url: 'https://example.com/notice/1' },
        request: { res: { responseUrl: 'https://example.com/notice/1' } },
        headers: {},
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetchHtmlPage.mockResolvedValue(mockResponse as any);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice], {
        reason: ArchiveReason.PAL_RECOMPARE,
      });

      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.DEBUG,
        'ArchiveOrchestratorService',
        'Re-comparing archived notices for drift: **1** item(s)',
        expect.objectContaining({
          count: 1,
          reason: ArchiveReason.PAL_RECOMPARE,
        }),
      );
    });
  });

  describe('filterAlreadyArchivedNotices', () => {
    it('should return empty array for empty input', async () => {
      const result = await service.filterAlreadyArchivedNotices([]);

      expect(result).toEqual([]);
      expect(
        noticeArchiveService.getExistingNoticeNumSet,
      ).not.toHaveBeenCalled();
    });

    it('should filter out already archived notices', async () => {
      const notices = [
        { num: 1, subject: 'Notice 1' },
        { num: 2, subject: 'Notice 2' },
        { num: 3, subject: 'Notice 3' },
      ];

      (
        noticeArchiveService.getExistingNoticeNumSet as jest.Mock
      ).mockResolvedValue(new Set([1, 3]));

      const result = await service.filterAlreadyArchivedNotices(notices);

      expect(noticeArchiveService.getExistingNoticeNumSet).toHaveBeenCalledWith(
        [1, 2, 3],
      );
      expect(result).toEqual([{ num: 2, subject: 'Notice 2' }]);
    });

    it('should return all notices when none are archived', async () => {
      const notices = [
        { num: 1, subject: 'Notice 1' },
        { num: 2, subject: 'Notice 2' },
      ];

      (
        noticeArchiveService.getExistingNoticeNumSet as jest.Mock
      ).mockResolvedValue(new Set());

      const result = await service.filterAlreadyArchivedNotices(notices);

      expect(result).toEqual(notices);
    });

    it('should return empty array when all notices are archived', async () => {
      const notices = [
        { num: 1, subject: 'Notice 1' },
        { num: 2, subject: 'Notice 2' },
      ];

      (
        noticeArchiveService.getExistingNoticeNumSet as jest.Mock
      ).mockResolvedValue(new Set([1, 2]));

      const result = await service.filterAlreadyArchivedNotices(notices);

      expect(result).toEqual([]);
    });
  });

  describe('backfillMissingSnapshotArtifacts', () => {
    const palCaptureResponse = {
      data: '<html>backfilled</html>',
      statusText: 'OK',
      config: { url: 'https://example.com/notice/7' },
      request: { res: { responseUrl: 'https://example.com/notice/7' } },
      status: 200,
      headers: { 'content-type': 'text/html' },
    };

    const setTargets = (targets: {
      pal?: Array<{ num: number; assemblyLink: string }>;
      nsm?: Array<{ num: number }>;
    }) => {
      (
        noticeArchiveService.getNoticesWithMissingSnapshotArtifacts as jest.Mock
      ).mockResolvedValue({ pal: targets.pal ?? [], nsm: targets.nsm ?? [] });
    };

    it('returns zero counts and skips querying when nothing is deficient', async () => {
      setTargets({});

      const result = await service.backfillMissingSnapshotArtifacts();

      expect(result).toEqual({
        palScanned: 0,
        palFilled: 0,
        nsmScanned: 0,
        nsmFilled: 0,
        failed: 0,
      });
      expect(noticeArchiveService.updateSourceHtml).not.toHaveBeenCalled();
      expect(
        noticeArchiveService.updateNsmHtmlAndDetail,
      ).not.toHaveBeenCalled();
    });

    it('fills PAL source html for deficient rows', async () => {
      setTargets({
        pal: [{ num: 7, assemblyLink: 'https://example.com/notice/7' }],
      });
      mockFetchHtmlPage.mockResolvedValue(palCaptureResponse as any);

      const result = await service.backfillMissingSnapshotArtifacts();

      expect(result.palFilled).toBe(1);
      expect(result.failed).toBe(0);
      expect(noticeArchiveService.updateSourceHtml).toHaveBeenCalledWith(
        7,
        '<html>backfilled</html>',
        computeSha256('<html>backfilled</html>'),
        expect.objectContaining({
          requestUrl: 'https://example.com/notice/7',
          statusCode: 200,
        }),
      );
    });

    it('counts a failed PAL capture without aborting the remaining rows', async () => {
      setTargets({
        pal: [
          { num: 7, assemblyLink: 'https://example.com/notice/7' },
          { num: 8, assemblyLink: 'https://example.com/notice/8' },
        ],
      });
      mockFetchHtmlPage
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(palCaptureResponse as any);

      const result = await service.backfillMissingSnapshotArtifacts();

      expect(result.palScanned).toBe(2);
      expect(result.palFilled).toBe(1);
      expect(result.failed).toBe(1);
      expect(noticeArchiveService.updateSourceHtml).toHaveBeenCalledTimes(1);
    });

    it('fills NSM html, http metadata and screenshot from a single capture', async () => {
      setTargets({ nsm: [{ num: 2220565 }] });
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>nsm</html>',
          screenshot: Buffer.from('shot'),
          detail: { proposalReason: '사유', session: '제418회' },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2220565/detailRP',
          statusCode: 200,
        },
      );

      const result = await service.backfillMissingSnapshotArtifacts();

      expect(result.nsmFilled).toBe(1);
      expect(noticeArchiveService.updateNsmHtmlAndDetail).toHaveBeenCalledWith(
        2220565,
        expect.objectContaining({
          html: '<html>nsm</html>',
          sha256: computeSha256('<html>nsm</html>'),
          screenshotBlob: Buffer.from('shot'),
          screenshotFormat: 'jpeg',
          httpMetadata: expect.objectContaining({
            requestUrl:
              'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2220565/detailRP',
            statusCode: 200,
          }),
        }),
      );
    });

    it('never writes a blank NSM capture to the snapshot', async () => {
      setTargets({ nsm: [{ num: 2220565 }] });
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '   ',
          screenshot: null,
          detail: null,
          responseUrl: 'https://opinion.lawmaking.go.kr/',
          statusCode: 200,
        },
      );

      const result = await service.backfillMissingSnapshotArtifacts();

      expect(result.nsmFilled).toBe(0);
      expect(result.failed).toBe(1);
      expect(
        noticeArchiveService.updateNsmHtmlAndDetail,
      ).not.toHaveBeenCalled();
    });

    it('does not count a deleted NSM source page as a backfill failure', async () => {
      setTargets({ nsm: [{ num: 2219717 }] });
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockRejectedValue(
        new NsmBillDeletedError('2219717', '안건정보가 없습니다.'),
      );

      const result = await service.backfillMissingSnapshotArtifacts();

      expect(result.nsmScanned).toBe(1);
      expect(result.nsmFilled).toBe(0);
      expect(result.failed).toBe(0);
      expect(
        noticeArchiveService.updateNsmHtmlAndDetail,
      ).not.toHaveBeenCalled();
    });

    it('caps browser-driven NSM captures per run', async () => {
      setTargets({
        nsm: Array.from({ length: 50 }, (_, idx) => ({ num: 2220000 + idx })),
      });
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>nsm</html>',
          screenshot: null,
          detail: { proposalReason: '사유' },
          responseUrl: 'https://opinion.lawmaking.go.kr/',
          statusCode: 200,
        },
      );

      const result = await service.backfillMissingSnapshotArtifacts();

      expect(result.nsmScanned).toBe(20);
      expect(result.nsmFilled).toBe(20);
      expect(crawlingCoreService.captureNsmDetailFull).toHaveBeenCalledTimes(
        20,
      );
    });

    it('forwards the requested limit to the deficiency query', async () => {
      setTargets({});

      await service.backfillMissingSnapshotArtifacts(30);

      expect(
        noticeArchiveService.getNoticesWithMissingSnapshotArtifacts,
      ).toHaveBeenCalledWith(30);
    });

    it('ignores a concurrent run instead of double-capturing', async () => {
      setTargets({
        pal: [{ num: 7, assemblyLink: 'https://example.com/notice/7' }],
      });

      let releaseCapture: (() => void) | null = null;
      mockFetchHtmlPage.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseCapture = () => resolve(palCaptureResponse as any);
          }),
      );

      const first = service.backfillMissingSnapshotArtifacts();
      await Promise.resolve();
      const second = await service.backfillMissingSnapshotArtifacts();

      expect(second.palScanned).toBe(0);
      expect(
        noticeArchiveService.getNoticesWithMissingSnapshotArtifacts,
      ).toHaveBeenCalledTimes(1);

      releaseCapture!();
      await expect(first).resolves.toMatchObject({ palFilled: 1 });
    });
  });

  describe('fetchAndUpdateProposalReason', () => {
    it('returns proposalReason and appends NSM detail update when capture succeeds', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>nsm detail</html>',
          screenshot: Buffer.from('shot'),
          detail: { proposalReason: '  사유 본문  ', session: '제418회' },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219775/detailRP',
          statusCode: 200,
        },
      );
      (
        noticeArchiveService.getLatestProposalReasonForNotice as jest.Mock
      ).mockResolvedValue('사유 본문');

      const result = await service.fetchAndUpdateProposalReason(
        2219775,
        '2219775',
      );

      expect(result).toBe('사유 본문');
      expect(noticeArchiveService.updateNsmHtmlAndDetail).toHaveBeenCalledWith(
        2219775,
        expect.objectContaining({
          proposalReason: '사유 본문',
          html: '<html>nsm detail</html>',
          sha256: computeSha256('<html>nsm detail</html>'),
          screenshotBlob: Buffer.from('shot'),
          screenshotFormat: 'jpeg',
          httpMetadata: expect.objectContaining({
            requestUrl:
              'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219775/detailRP',
            responseUrl:
              'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219775/detailRP',
            statusCode: 200,
          }),
        }),
      );
    });

    it('returns null when proposalReason is still empty after capture', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>nsm detail</html>',
          screenshot: null,
          detail: { proposalReason: '   ', session: null },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219777/detailRP',
          statusCode: 200,
        },
      );

      const result = await service.fetchAndUpdateProposalReason(
        2219777,
        '2219777',
      );

      expect(result).toBeNull();
      expect(noticeArchiveService.updateNsmHtmlAndDetail).toHaveBeenCalledWith(
        2219777,
        expect.objectContaining({
          proposalReason: '',
          html: '<html>nsm detail</html>',
          sha256: computeSha256('<html>nsm detail</html>'),
          screenshotBlob: undefined,
          screenshotFormat: undefined,
        }),
      );
    });

    it('sends no html artifacts when the captured page is blank', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '   \n  ',
          screenshot: Buffer.alloc(0),
          detail: { proposalReason: '사유 본문', session: null },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219781/detailRP',
          statusCode: 200,
        },
      );
      (
        noticeArchiveService.getLatestProposalReasonForNotice as jest.Mock
      ).mockResolvedValue('사유 본문');

      await service.fetchAndUpdateProposalReason(2219781, '2219781');

      expect(noticeArchiveService.updateNsmHtmlAndDetail).toHaveBeenCalledWith(
        2219781,
        expect.objectContaining({
          html: '',
          sha256: '',
          httpMetadata: null,
          screenshotBlob: undefined,
          screenshotFormat: undefined,
        }),
      );
    });

    it('trims the billNo before building the request url', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>nsm detail</html>',
          screenshot: null,
          detail: { proposalReason: '사유 본문', session: null },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219782/detailRP',
          statusCode: 200,
        },
      );
      (
        noticeArchiveService.getLatestProposalReasonForNotice as jest.Mock
      ).mockResolvedValue('사유 본문');

      await service.fetchAndUpdateProposalReason(2219782, '  2219782  ');

      expect(noticeArchiveService.updateNsmHtmlAndDetail).toHaveBeenCalledWith(
        2219782,
        expect.objectContaining({
          httpMetadata: expect.objectContaining({
            requestUrl:
              'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219782/detailRP',
          }),
        }),
      );
    });

    it('accepts latest-chain reason with different whitespace formatting', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>nsm detail</html>',
          screenshot: null,
          detail: { proposalReason: '사유 본문', session: '제418회' },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219780/detailRP',
          statusCode: 200,
        },
      );
      (
        noticeArchiveService.getLatestProposalReasonForNotice as jest.Mock
      ).mockResolvedValue('사유   본문');

      const result = await service.fetchAndUpdateProposalReason(
        2219780,
        '2219780',
      );

      expect(result).toBe('사유 본문');
      expect(noticeArchiveService.updateNsmHtmlAndDetail).toHaveBeenCalledWith(
        2219780,
        expect.objectContaining({
          proposalReason: '사유 본문',
          html: '<html>nsm detail</html>',
          sha256: computeSha256('<html>nsm detail</html>'),
        }),
      );
    });

    it('marks source as deleted when NSM detail page reports missing bill', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockRejectedValue(
        new NsmBillDeletedError('2219717', '안건정보가 없습니다.'),
      );
      (
        crawlingCoreService.probeNsmDeletedBillAlert as jest.Mock
      ).mockResolvedValue('안건정보가 없습니다.');

      const result = await service.fetchAndUpdateProposalReason(
        2219717,
        '2219717',
      );

      expect(result).toBeNull();
      expect(
        noticeArchiveService.appendSourceDeletedEventByNoticeNum,
      ).toHaveBeenCalledWith(2219717);
      expect(
        noticeArchiveService.flushQueuedChangeNotifications,
      ).toHaveBeenCalledTimes(1);
      expect(
        (noticeArchiveService.appendSourceDeletedEventByNoticeNum as jest.Mock)
          .mock.invocationCallOrder[0],
      ).toBeLessThan(
        (noticeArchiveService.flushQueuedChangeNotifications as jest.Mock).mock
          .invocationCallOrder[0],
      );
      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.WARN,
        'ArchiveOrchestratorService',
        'proposalReason backfill confirmed deleted NSM bill **2219717**: 안건정보가 없습니다.',
        expect.objectContaining({
          noticeNum: 2219717,
          billNo: '2219717',
          detectedAs: SourceDeletionDetectedAs.SOURCE_DELETED,
          detectionMethod:
            SourceDeletionDetectionMethod.NSM_ERROR_CONFIRMED_VIA_HTTP_PROBE,
        }),
      );
    });

    it('does not append source_deleted event when NsmBillDeletedError is not confirmed by HTTP probe', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockRejectedValue(
        new NsmBillDeletedError('2219717', '안건정보가 없습니다.'),
      );
      (
        crawlingCoreService.probeNsmDeletedBillAlert as jest.Mock
      ).mockResolvedValue(null);

      const result = await service.fetchAndUpdateProposalReason(
        2219717,
        '2219717',
      );

      expect(result).toBeNull();
      expect(crawlingCoreService.probeNsmDeletedBillAlert).toHaveBeenCalledWith(
        '2219717',
      );
      expect(
        noticeArchiveService.appendSourceDeletedEventByNoticeNum,
      ).not.toHaveBeenCalled();
      expect(
        noticeArchiveService.flushQueuedChangeNotifications,
      ).not.toHaveBeenCalled();
      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.WARN,
        'ArchiveOrchestratorService',
        'proposalReason backfill deletion signal was not confirmed for bill **2219717**; skipped source_deleted event',
        expect.objectContaining({
          noticeNum: 2219717,
          billNo: '2219717',
          detectedAs: SourceDeletionDetectedAs.UNCONFIRMED,
          detectionMethod:
            SourceDeletionDetectionMethod.NSM_ERROR_WITHOUT_HTTP_PROBE_CONFIRMATION,
        }),
      );
    });

    it('marks source as deleted via HTTP probe when capture times out', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockRejectedValue(
        new Error('Navigation timeout of 30000 ms exceeded'),
      );
      (
        crawlingCoreService.probeNsmDeletedBillAlert as jest.Mock
      ).mockResolvedValue('안건정보가 없습니다.');

      const result = await service.fetchAndUpdateProposalReason(
        2219717,
        '2219717',
      );

      expect(result).toBeNull();
      expect(crawlingCoreService.probeNsmDeletedBillAlert).toHaveBeenCalledWith(
        '2219717',
      );
      expect(
        noticeArchiveService.appendSourceDeletedEventByNoticeNum,
      ).toHaveBeenCalledWith(2219717);
      expect(
        noticeArchiveService.flushQueuedChangeNotifications,
      ).toHaveBeenCalledTimes(1);
      expect(
        (noticeArchiveService.appendSourceDeletedEventByNoticeNum as jest.Mock)
          .mock.invocationCallOrder[0],
      ).toBeLessThan(
        (noticeArchiveService.flushQueuedChangeNotifications as jest.Mock).mock
          .invocationCallOrder[0],
      );
      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.WARN,
        'ArchiveOrchestratorService',
        'proposalReason backfill detected deleted NSM bill **2219717** via HTTP probe: 안건정보가 없습니다.',
        expect.objectContaining({
          noticeNum: 2219717,
          billNo: '2219717',
          detectedAs: SourceDeletionDetectedAs.SOURCE_DELETED,
          detectionMethod:
            SourceDeletionDetectionMethod.HTTP_PROBE_AFTER_TIMEOUT,
        }),
      );
    });

    // it('marks source as deleted when NSM detail page returns HTTP 404', async () => {
    //   (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
    //     {
    //       html: '<html>404</html>',
    //       screenshot: null,
    //       detail: null,
    //       responseUrl:
    //         'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219718/detailRP',
    //       statusCode: 404,
    //     },
    //   );

    //   const result = await service.fetchAndUpdateProposalReason(
    //     2219718,
    //     '2219718',
    //   );

    //   expect(result).toBeNull();
    //   expect(
    //     noticeArchiveService.appendSourceDeletedEventByNoticeNum,
    //   ).toHaveBeenCalledWith(2219718);
    //   expect(
    //     noticeArchiveService.flushQueuedChangeNotifications,
    //   ).toHaveBeenCalledTimes(1);
    //   expect(
    //     crawlingCoreService.probeNsmDeletedBillAlert,
    //   ).not.toHaveBeenCalled();
    //   expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
    //     BridgeLogLevel.WARN,
    //     'ArchiveOrchestratorService',
    //     'proposalReason backfill detected deleted NSM bill **2219718** via detail page HTTP 404',
    //     expect.objectContaining({
    //       noticeNum: 2219718,
    //       billNo: '2219718',
    //       detectedAs: SourceDeletionDetectedAs.SOURCE_DELETED,
    //       detectionMethod: SourceDeletionDetectionMethod.DETAIL_PAGE_HTTP_404,
    //       statusCode: 404,
    //       responseUrl:
    //         'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219718/detailRP',
    //     }),
    //   );
    // });
  });

  describe('archiveNsmBillItems', () => {
    it('exposes real NSM detail crawl progress while archiveNsmBillItems is running', async () => {
      let resolveCapture:
        | ((value: {
            html: string;
            screenshot: null;
            detail: {
              proposalReason: string;
              proposalInfo: string;
              billNo: string;
              proposer: string;
              proposalDate: string;
              session: string;
            };
            responseUrl: string;
            statusCode: number;
          }) => void)
        | null = null;

      (
        crawlingCoreService.captureNsmDetailFull as jest.Mock
      ).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCapture = resolve;
          }),
      );
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      const runPromise = service.archiveNsmBillItems([mockNsmBillItem]);

      expect(service.getNsmDetailCrawlProgressState()).toMatchObject({
        status: 'running',
        reason: NsmArchiveReason.NEW_PENDING_BILLS,
        totalItems: 1,
        processedItems: 0,
        succeededItems: 0,
        failedItems: 0,
        currentIndex: 1,
        currentBillNo: '2219776',
      });

      resolveCapture?.({
        html: '<html>nsm detail</html>',
        screenshot: null,
        detail: {
          proposalReason: '사유 본문',
          proposalInfo: '테스트 NSM 법률안',
          billNo: '2219776',
          proposer: '홍길동의원',
          proposalDate: '2026-07-01',
          session: '제418회',
        },
        responseUrl:
          'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219776/detailRP',
        statusCode: 200,
      });

      await runPromise;

      expect(service.getNsmDetailCrawlProgressState()).toMatchObject({
        status: 'idle',
        reason: NsmArchiveReason.NEW_PENDING_BILLS,
        totalItems: 1,
        processedItems: 1,
        succeededItems: 1,
        failedItems: 0,
        currentIndex: 0,
        currentBillNo: null,
      });
      expect(service.getNsmDetailCrawlProgressState().lastCompletedAt).not.toBe(
        null,
      );
    });

    it('logs default message for new pending bills', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>nsm detail</html>',
          screenshot: null,
          detail: {
            proposalReason: '사유 본문',
            proposalInfo: '테스트 NSM 법률안',
            billNo: '2219776',
            proposer: '홍길동의원',
            proposalDate: '2026-07-01',
            session: '제418회',
          },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219776/detailRP',
          statusCode: 200,
        },
      );
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNsmBillItems([mockNsmBillItem]);

      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.LOG,
        'ArchiveOrchestratorService',
        'Archiving **1** pending bill(s) from NsmLmSts',
        expect.objectContaining({
          count: 1,
          reason: NsmArchiveReason.NEW_PENDING_BILLS,
        }),
      );
    });

    it('logs recompare message for existing pending bills refresh', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>nsm detail</html>',
          screenshot: null,
          detail: {
            proposalReason: '사유 본문',
            proposalInfo: '테스트 NSM 법률안',
            billNo: '2219776',
            proposer: '홍길동의원',
            proposalDate: '2026-07-01',
            session: '제418회',
          },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2219776/detailRP',
          statusCode: 200,
        },
      );
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNsmBillItems([mockNsmBillItem], {
        reason: NsmArchiveReason.EXISTING_PENDING_RECOMPARE,
      });

      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.DEBUG,
        'ArchiveOrchestratorService',
        'Re-scanning archived pending bills from NsmLmSts: **1** item(s)',
        expect.objectContaining({
          count: 1,
          reason: NsmArchiveReason.EXISTING_PENDING_RECOMPARE,
        }),
      );
    });
  });
});
