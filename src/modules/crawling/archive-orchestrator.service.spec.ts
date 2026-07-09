import { Test, TestingModule } from '@nestjs/testing';
import { ArchiveOrchestratorService } from './archive-orchestrator.service';
import { NoticeArchiveService } from '../notice/notice-archive.service';
import {
  CrawlingCoreService,
  NsmBillDeletedError,
} from './crawling-core.service';
import { CacheService } from '../cache/cache.service';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { type CachedNotice } from '../../types/cache.types';
import { type INsmBillItem } from 'pal-crawl';

// fetch를 모킹
declare const global: any;
const mockFetch = jest.fn();
global.fetch = mockFetch;

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
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn((header: string) => {
            const headers: Record<string, string> = {
              'content-type': 'text/html',
              etag: 'test-etag',
              'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
            };
            return headers[header] || null;
          }),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue(
        mockContent,
      );
      mockFetch.mockResolvedValue(mockResponse);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice]);

      expect(crawlingCoreService.getContent).toHaveBeenCalledWith('content-1');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/notice/1',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'User-Agent': 'LawCast/1.0 (Legislative Notice Crawler)',
          }),
          redirect: 'follow',
          signal: expect.any(Object),
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
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/2',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      mockFetch.mockResolvedValue(mockResponse);
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
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockRejectedValue(
        new Error('Content fetch failed'),
      );
      mockFetch.mockResolvedValue(mockResponse);
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
      mockFetch.mockRejectedValue(new Error('HTML capture failed'));
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
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetch.mockResolvedValue(mockResponse);
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
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetch.mockResolvedValue(mockResponse);
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
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetch.mockResolvedValue(mockResponse);
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
          reason: 'new-notices',
        }),
      );
    });

    it('should log recompare reason with DEBUG level', async () => {
      const mockResponse = {
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Test HTML</html>'),
        url: 'https://example.com/notice/1',
        status: 200,
        headers: {
          get: jest.fn(() => null),
        },
      };

      (crawlingCoreService.getContent as jest.Mock).mockResolvedValue({
        title: 'Test Title',
        proposalReason: 'Test Proposal Reason',
      });
      mockFetch.mockResolvedValue(mockResponse);
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNotices([mockNotice], { reason: 'pal-recompare' });

      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.DEBUG,
        'ArchiveOrchestratorService',
        'Re-comparing archived notices for drift: **1** item(s)',
        expect.objectContaining({
          count: 1,
          reason: 'pal-recompare',
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
          html: '',
          sha256: '',
          httpMetadata: null,
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
          html: '',
          sha256: '',
          httpMetadata: null,
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
          html: '',
          sha256: '',
          httpMetadata: null,
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
          detectedAs: 'source_deleted',
          detectionMethod: 'nsm-error-confirmed-via-http-probe',
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
          detectedAs: 'unconfirmed',
          detectionMethod: 'nsm-error-without-http-probe-confirmation',
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
          detectedAs: 'source_deleted',
          detectionMethod: 'http-probe-after-timeout',
        }),
      );
    });
  });

  describe('archiveNsmBillItems', () => {
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
          reason: 'new-pending-bills',
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
        reason: 'existing-pending-recompare',
      });

      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.DEBUG,
        'ArchiveOrchestratorService',
        'Re-scanning archived pending bills from NsmLmSts: **1** item(s)',
        expect.objectContaining({
          count: 1,
          reason: 'existing-pending-recompare',
        }),
      );
    });
  });
});
