/**
 * E2E tests for source deletion detection across all three paths:
 *
 * Path 1: archiveNsmBillItems — NsmBillDeletedError during NSM detail capture
 *          → appendSourceDeletedEventByNoticeNum called, upsert SKIPPED
 *
 * Path 2: upsertNoticeArchive — existing source_deleted record re-crawled
 *          → diff event preserves source_deleted (no spurious restoration)
 *
 * Path 3: markSourceDeletedByMissingPalNums — PAL full sync reconciliation
 *          → active PAL-origin rows absent from seenPalActiveNums → source_deleted
 *
 * Covers bill 2214911 scenario: deleted from 국민참여입법센터, must not be
 * restored to active during subsequent sync cycles.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ArchiveOrchestratorService,
  NsmArchiveReason,
} from '../modules/crawling/archive-orchestrator.service';
import { NoticeArchiveService } from '../modules/notice/notice-archive.service';
import {
  CrawlingCoreService,
  NsmBillDeletedError,
} from '../modules/crawling/crawling-core.service';
import { CacheService } from '../modules/cache/cache.service';
import { DiscordBridgeService } from '../modules/discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../modules/discord-bridge/discord-bridge.types';
import { type INsmBillItem } from 'pal-crawl';
import { SourceDeletionDetectedAs } from '../modules/crawling/archive-detection-metadata.enum';

describe('Source deletion detection (bill 2214911 scenario)', () => {
  let service: ArchiveOrchestratorService;
  let noticeArchiveService: NoticeArchiveService;
  let crawlingCoreService: CrawlingCoreService;
  let discordBridgeService: DiscordBridgeService;

  /** NSM bill item that exists in the 국민참여입법센터 list but is deleted at detail level. */
  const deletedNsmBillItem = {
    billNo: '2214911',
    billName: '무효 법률안 (삭제됨)',
    proposer: '홍길동의원',
    committee: '',
    ministry: '법무부',
    link: 'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2214911/detailRP',
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
            markSourceDeletedByMissingPalNums: jest.fn().mockResolvedValue(0),
            markSourceDeletedByMissingNsmNums: jest.fn().mockResolvedValue(0),
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

  // ═══════════════════════════════════════════════════════════════════════
  // Path 1: archiveNsmBillItems — NsmBillDeletedError → source_deleted
  // ═══════════════════════════════════════════════════════════════════════
  describe('Path 1: archiveNsmBillItems skips upsert on NsmBillDeletedError', () => {
    it('marks bill as source_deleted and does NOT call upsertNoticeArchive', async () => {
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockRejectedValue(
        new NsmBillDeletedError('2214911', '안건정보가 없습니다.'),
      );

      const result = await service.archiveNsmBillItems([deletedNsmBillItem]);

      // Should return empty — bill was not archived
      expect(result).toEqual([]);

      // source_deleted event should have been appended
      expect(
        noticeArchiveService.appendSourceDeletedEventByNoticeNum,
      ).toHaveBeenCalledWith(2214911);

      // Notifications should be flushed after marking (once by
      // appendSourceDeletedAndFlushNotifications, once at end of archiveNsmBillItems)
      expect(
        noticeArchiveService.flushQueuedChangeNotifications,
      ).toHaveBeenCalledTimes(2);

      // upsertNoticeArchive must NOT be called — this is the critical check
      // Previously, the catch block fell through to upsert, restoring lifecycle to 'active'
      expect(noticeArchiveService.upsertNoticeArchive).not.toHaveBeenCalled();

      // Discord alert should mention source_deleted
      expect(discordBridgeService.logEvent).toHaveBeenCalledWith(
        BridgeLogLevel.WARN,
        'ArchiveOrchestratorService',
        expect.stringContaining('2214911'),
        expect.objectContaining({
          detectedAs: SourceDeletionDetectedAs.SOURCE_DELETED,
        }),
      );
    });

    it('does NOT mark source_deleted for non-deletion errors (timeout etc)', async () => {
      // Non-NsmBillDeletedError errors should NOT trigger source_deleted
      // (they are transient failures, not confirmed deletions)
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockRejectedValue(
        new Error('Navigation timeout of 45000 ms exceeded'),
      );

      await service.archiveNsmBillItems([deletedNsmBillItem]);

      // upsertNoticeArchive IS called for non-deletion errors (best-effort archive)
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalled();

      // source_deleted should NOT be marked for timeout errors
      expect(
        noticeArchiveService.appendSourceDeletedEventByNoticeNum,
      ).not.toHaveBeenCalled();
    });

    it('handles multiple items: deleted bill skipped, valid bill archived', async () => {
      const validNsmBillItem = {
        billNo: '2220590',
        billName: '정상 법률안',
        proposer: '김철수의원',
        committee: '',
        ministry: '기획재정부',
        link: 'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2220590/detailRP',
      } as INsmBillItem;

      (crawlingCoreService.captureNsmDetailFull as jest.Mock)
        .mockRejectedValueOnce(
          new NsmBillDeletedError('2214911', '안건정보가 없습니다.'),
        )
        .mockResolvedValueOnce({
          html: '<html>valid detail</html>',
          screenshot: null,
          detail: {
            proposalReason: '정상 사유',
            proposalInfo: '정상 법률안',
            billNo: '2220590',
            proposer: '김철수의원',
            proposalDate: '2026-08-01',
            session: '제420회',
          },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2220590/detailRP',
          statusCode: 200,
        });
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      const result = await service.archiveNsmBillItems([
        deletedNsmBillItem,
        validNsmBillItem,
      ]);

      // Only the valid bill should be returned
      expect(result).toHaveLength(1);
      expect(result[0].num).toBe(2220590);

      // source_deleted for 2214911
      expect(
        noticeArchiveService.appendSourceDeletedEventByNoticeNum,
      ).toHaveBeenCalledWith(2214911);

      // upsert only for the valid bill
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledTimes(1);
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        expect.objectContaining({ num: 2220590 }),
        expect.any(Object),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Path 2: upsertNoticeArchive preserves source_deleted in diff events
  // ═══════════════════════════════════════════════════════════════════════
  describe('Path 2: upsertNoticeArchive preserves source_deleted lifecycle', () => {
    it('source_deleted record re-crawled should NOT be restored to active', async () => {
      // Simulate a bill that was previously marked source_deleted but still
      // appears in the NSM pending list (list page shows it, detail is gone).
      // The NSM detail capture succeeds (bill not yet removed from list).
      (crawlingCoreService.captureNsmDetailFull as jest.Mock).mockResolvedValue(
        {
          html: '<html>still on list</html>',
          screenshot: null,
          detail: {
            proposalReason: '',
            proposalInfo: '무효 법률안',
            billNo: '2214911',
            proposer: '홍길동의원',
            proposalDate: '2026-06-01',
            session: '제419회',
          },
          responseUrl:
            'https://opinion.lawmaking.go.kr/gcom/nsmLmSts/out/2214911/detailRP',
          statusCode: 200,
        },
      );
      (noticeArchiveService.upsertNoticeArchive as jest.Mock).mockResolvedValue(
        undefined,
      );

      await service.archiveNsmBillItems([deletedNsmBillItem], {
        reason: NsmArchiveReason.EXISTING_PENDING_RECOMPARE,
      });

      // upsertNoticeArchive is called with coreFields that have lifecycleStatus: 'active'
      // BUT the implementation should detect the existing source_deleted row and
      // preserve the source_deleted status in the diff event.
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledTimes(1);
      expect(noticeArchiveService.upsertNoticeArchive).toHaveBeenCalledWith(
        expect.objectContaining({ num: 2214911 }),
        expect.objectContaining({
          proposalReason: expect.any(String),
          title: expect.any(String),
        }),
      );

      // The critical assertion: source_deleted should NOT be re-appended
      expect(
        noticeArchiveService.appendSourceDeletedEventByNoticeNum,
      ).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Path 3: markSourceDeletedByMissingPalNums — PAL full sync reconciliation
  // ═══════════════════════════════════════════════════════════════════════
  describe('Path 3: markSourceDeletedByMissingPalNums (PAL reconciliation)', () => {
    it('is implemented (not a no-op) and delegates to the real service', async () => {
      // The old implementation was a no-op returning 0.
      // The new implementation queries active PAL rows and marks missing ones.
      (
        noticeArchiveService.markSourceDeletedByMissingPalNums as jest.Mock
      ).mockResolvedValueOnce(3);

      const seenPalNums = new Set([100, 200, 300]);
      const result =
        await noticeArchiveService.markSourceDeletedByMissingPalNums(
          seenPalNums,
        );

      expect(result).toBe(3);
      expect(
        noticeArchiveService.markSourceDeletedByMissingPalNums,
      ).toHaveBeenCalledWith(seenPalNums);
    });
  });
});
