import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  IsNull,
  LessThan,
  MoreThan,
  Not,
  type FindOptionsWhere,
  Repository,
  Brackets,
} from 'typeorm';
import {
  type AISummaryStatus,
  type CachedNotice,
} from '../../types/cache.types';
import { AI_SUMMARY_STATUS } from '../crawling/utils/ai-summary-status.utils';
import {
  NoticeArchive,
  type NoticeLifecycleStatus,
} from '../notice/notice-archive.entity';
import {
  NOTICE_ITEM_SELECT,
  buildArchiveWhereConditions,
  mapArchiveEntityToCachedNotice,
  mapArchiveEntityToNoticeItem,
  normalizeSortOrder,
  parseOptionalDate,
} from './notice-archive.helpers';
import { mapConcurrently } from '../../utils/concurrency.utils';
import { NoticeArchiveArtifactSupport } from './utils/notice-archive-artifact-support';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import { type ChangeEventType } from '../change-tracking/notice-change-event.entity';
import {
  canonicalStringify,
  computeDiff,
  sha256Hex,
} from '../change-tracking/change-tracking-diff.utils';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';

export interface ArchiveListQuery {
  page: number;
  limit: number;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  sortOrder?: 'asc' | 'desc';
  isDone?: boolean;
  /** When true, also searches proposalReason (원문). Expensive on large tables. */
  fullText?: boolean;
}

export interface ArchiveOffsetQuery {
  skip: number;
  take: number;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  sortOrder?: 'asc' | 'desc';
  isDone?: boolean;
  /** Pre-computed total; when provided, the COUNT query is skipped. */
  knownTotal?: number;
  /** When true, also searches proposalReason (원문). Expensive on large tables. */
  fullText?: boolean;
}

export interface ArchiveNumCompareCountQuery {
  num: number;
  operator: 'gt' | 'lt';
  search?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface ArchiveNoticeItem {
  num: number;
  subject: string;
  proposerCategory: string;
  committee: string;
  link: string;
  contentId: string | null;
  isDone: boolean;
  aiSummary: string | null;
  aiSummaryStatus: AISummaryStatus;
  attachments: {
    pdfFile: string;
    hwpFile: string;
  };
  lifecycleStatus: NoticeLifecycleStatus;
  sourceDeletedAt: Date | null;
  archiveStartedAt: Date;
  lastUpdatedAt: Date;
}

export interface ArchiveDetailResult {
  notice: ArchiveNoticeItem;
  originalContent: {
    contentId: string;
    title: string;
    proposalReason: string;
    billNumber: string | null;
    proposer: string | null;
    proposalDate: string | null;
    committee: string | null;
    referralDate: string | null;
    noticePeriod: string | null;
    proposalSession: string | null;
  };
  archiveMetadata: {
    archivedAt: Date | null;
    sourceHtmlSha256: string | null;
    sourceHtmlSize: number;
    integrity: {
      checkedAt: Date | null;
      passed: boolean | null;
      calculatedSha256: string | null;
    };
    http: {
      fetchedAt: Date | null;
      statusCode: number | null;
      contentType: string | null;
      etag: string | null;
      lastModified: string | null;
      requestUrl?: string;
      responseUrl?: string;
    };
  };
  screenshotMeta: {
    hasScreenshot: boolean;
    format: string | null;
  };
}

export interface ArchiveSummaryState {
  aiSummary: string | null;
  aiSummaryStatus: AISummaryStatus;
}

export interface ArchiveExportResult {
  zipFileName: string;
  jsonFileName: string;
  jsonContent: string;
  integrityFileName: string;
  integrityContent: string;
  changeTrackingFileName?: string;
  changeTrackingContent?: string;
  verificationScripts?: Array<{
    fileName: string;
    content: string;
  }>;
}

export interface ArchiveHttpMetadata {
  requestUrl?: string;
  responseUrl?: string;
  fetchedAt?: string;
  statusCode?: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  [key: string]: unknown;
}

type TrackedArchiveRow = Pick<
  NoticeArchive,
  | 'noticeNum'
  | 'subject'
  | 'proposerCategory'
  | 'committee'
  | 'proposalReason'
  | 'contentBillNumber'
  | 'contentProposer'
  | 'contentProposalDate'
  | 'contentCommittee'
  | 'contentReferralDate'
  | 'contentNoticePeriod'
  | 'contentProposalSession'
  | 'isDone'
  | 'lifecycleStatus'
  | 'sourceDeletedAt'
>;

@Injectable()
export class NoticeArchiveService {
  private readonly logger = new Logger(NoticeArchiveService.name);
  private readonly artifactSupport: NoticeArchiveArtifactSupport;

  constructor(
    @InjectRepository(NoticeArchive)
    private readonly archiveRepository: Repository<NoticeArchive>,
    @Optional()
    private readonly changeTrackingService?: ChangeTrackingService,
    @Optional() private readonly discordBridge?: DiscordBridgeService,
  ) {
    this.artifactSupport = new NoticeArchiveArtifactSupport(
      this.archiveRepository,
    );
  }

  getRecommendedWriteConcurrency(defaultConcurrency: number): number {
    return this.isSqliteDriver() ? 1 : defaultConcurrency;
  }

  private isSqliteDriver(): boolean {
    const manager = this.archiveRepository.manager as {
      connection?: { options?: { type?: unknown } };
      dataSource?: { options?: { type?: unknown } };
    };
    const rawType =
      manager.connection?.options?.type ?? manager.dataSource?.options?.type;
    const type = String(rawType ?? '').toLowerCase();

    return type === 'sqlite' || type === 'better-sqlite3' || type === 'sqljs';
  }

  private normalizeStableId(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized && normalized.length > 0 ? normalized : null;
  }

  async upsertNoticeArchive(
    notice: CachedNotice,
    originalContent: {
      isDone?: boolean;
      proposalReason: string;
      title?: string | null;
      billNumber?: string | null;
      proposer?: string | null;
      proposalDate?: string | null;
      committee?: string | null;
      referralDate?: string | null;
      noticePeriod?: string | null;
      proposalSession?: string | null;
      sourceHtml?: string | null;
      htmlSha256?: string | null;
      archivedAt?: Date;
      httpMetadata?: ArchiveHttpMetadata | null;
      screenshotBlob?: Buffer | null;
      screenshotFormat?: string | null;
    },
  ): Promise<void> {
    const normalizedBillNumber = this.normalizeStableId(
      originalContent.billNumber,
    );
    const normalizedContentId = this.normalizeStableId(notice.contentId);

    let beforeRow = await this.getTrackedRowByNoticeNum(notice.num);

    if (!beforeRow && (normalizedContentId || normalizedBillNumber)) {
      beforeRow = await this.getTrackedRowByStableIdentity(
        notice.num,
        normalizedContentId,
        normalizedBillNumber,
      );
    }

    const normalizedHttpMetadata = originalContent.httpMetadata || null;
    const previousNoticeNum = beforeRow?.noticeNum ?? null;
    const isRenumbering =
      previousNoticeNum !== null && previousNoticeNum !== notice.num;

    // Core content fields - always written on both INSERT and UPDATE.
    const coreFields = {
      noticeNum: notice.num,
      subject: notice.subject,
      proposerCategory: notice.proposerCategory,
      committee: notice.committee,
      assemblyLink: notice.link,
      contentId: notice.contentId ?? null,
      proposalReason: originalContent.proposalReason ?? '',
      sourceTitle: originalContent.title?.trim() || notice.subject,
      contentBillNumber: originalContent.billNumber?.trim() || null,
      contentProposer: originalContent.proposer?.trim() || null,
      contentProposalDate: originalContent.proposalDate?.trim() || null,
      contentCommittee: originalContent.committee?.trim() || null,
      contentReferralDate: originalContent.referralDate?.trim() || null,
      contentNoticePeriod: originalContent.noticePeriod?.trim() || null,
      contentProposalSession: originalContent.proposalSession?.trim() || null,
      aiSummary: notice.aiSummary ?? null,
      aiSummaryStatus:
        notice.aiSummaryStatus ?? AI_SUMMARY_STATUS.NOT_REQUESTED,
      attachmentPdfFile: notice.attachments?.pdfFile ?? '',
      attachmentHwpFile: notice.attachments?.hwpFile ?? '',
      archivedAt: originalContent.archivedAt ?? new Date(),
      sourceHtml: originalContent.sourceHtml ?? null,
      sourceHtmlSha256: originalContent.htmlSha256 ?? null,
      httpMetadataJson: normalizedHttpMetadata
        ? JSON.stringify(normalizedHttpMetadata)
        : null,
      httpFetchedAt: parseOptionalDate(normalizedHttpMetadata?.fetchedAt),
      httpStatusCode: normalizedHttpMetadata?.statusCode ?? null,
      httpContentType: normalizedHttpMetadata?.contentType ?? null,
      httpEtag: normalizedHttpMetadata?.etag ?? null,
      httpLastModified: normalizedHttpMetadata?.lastModified ?? null,
      isDone: originalContent.isDone ?? false,
      lifecycleStatus: 'active' as NoticeLifecycleStatus,
      sourceDeletedAt: null,
    };

    const existing = beforeRow !== null;
    const updateNoticeNum = previousNoticeNum ?? notice.num;

    if (isRenumbering && beforeRow) {
      const beforeSnapshot = this.buildTrackedSnapshot(beforeRow);
      if (beforeSnapshot) {
        const invalidatedSnapshot = {
          ...beforeSnapshot,
          lifecycleStatus: 'renumbered',
        };
        await this.appendExplicitEventWithDiff({
          noticeNum: previousNoticeNum,
          source: 'archive:renumbered',
          eventType: 'invalidated',
          beforeSnapshot,
          afterSnapshot: invalidatedSnapshot,
          subject: beforeRow.subject,
        });
      }
    }

    if (existing) {
      // On UPDATE, only include screenshot fields when they were explicitly
      // provided - this prevents wiping a screenshot that was captured
      // asynchronously via updateScreenshot() after the initial archive.
      const screenshotUpdate =
        originalContent.screenshotBlob !== undefined
          ? {
              screenshotBlob: originalContent.screenshotBlob,
              screenshotFormat: originalContent.screenshotFormat ?? null,
            }
          : {};

      await this.archiveRepository.update(
        { noticeNum: updateNoticeNum },
        { ...coreFields, ...screenshotUpdate },
      );
    } else {
      await this.archiveRepository.save(
        this.archiveRepository.create({
          ...coreFields,
          screenshotBlob: originalContent.screenshotBlob ?? null,
          screenshotFormat: originalContent.screenshotFormat ?? null,
        }),
      );
    }

    await this.appendTrackedDiffEvent(notice.num, 'archive:upsert', beforeRow, {
      noticeNum: coreFields.noticeNum,
      subject: coreFields.subject,
      proposerCategory: coreFields.proposerCategory,
      committee: coreFields.committee,
      proposalReason: coreFields.proposalReason,
      contentBillNumber: coreFields.contentBillNumber,
      contentProposer: coreFields.contentProposer,
      contentProposalDate: coreFields.contentProposalDate,
      contentCommittee: coreFields.contentCommittee,
      contentReferralDate: coreFields.contentReferralDate,
      contentNoticePeriod: coreFields.contentNoticePeriod,
      contentProposalSession: coreFields.contentProposalSession,
      isDone: coreFields.isDone,
      lifecycleStatus: coreFields.lifecycleStatus,
      sourceDeletedAt: coreFields.sourceDeletedAt,
    });
  }

  /**
   * Bulk-updates archive records matching the given notice numbers to isDone=true.
   * Records already marked as done are not touched.
   * @returns Number of rows actually changed
   */
  async markNoticesDoneByNums(nums: number[]): Promise<number> {
    if (nums.length === 0) return 0;
    const result = await this.archiveRepository.update(
      { noticeNum: In(nums), isDone: false },
      {
        isDone: true,
        lifecycleStatus: 'active',
        sourceDeletedAt: null,
      },
    );
    return result.affected ?? 0;
  }

  /**
   * Bulk-reverts archive records matching the given notice numbers to isDone=false.
   * Records already marked as active are not touched.
   * @returns Number of rows actually changed
   */
  async revertNoticesDoneByNums(nums: number[]): Promise<number> {
    if (nums.length === 0) return 0;
    const result = await this.archiveRepository.update(
      { noticeNum: In(nums), isDone: true },
      {
        isDone: false,
        lifecycleStatus: 'active',
        sourceDeletedAt: null,
      },
    );
    return result.affected ?? 0;
  }

  async markSourceDeletedByMissingPalNums(
    seenPalActiveNums: Set<number>,
  ): Promise<number> {
    const candidates = await this.archiveRepository.find({
      where: {
        contentId: Not(IsNull()),
        isDone: false,
        lifecycleStatus: Not('source_deleted'),
      },
      select: {
        noticeNum: true,
        subject: true,
        proposerCategory: true,
        committee: true,
        proposalReason: true,
        contentBillNumber: true,
        contentProposer: true,
        contentProposalDate: true,
        contentCommittee: true,
        contentReferralDate: true,
        contentNoticePeriod: true,
        contentProposalSession: true,
        isDone: true,
        lifecycleStatus: true,
        sourceDeletedAt: true,
      },
    });

    const missing = candidates.filter(
      (row) => !seenPalActiveNums.has(row.noticeNum),
    );

    if (missing.length === 0) {
      return 0;
    }

    const markedAt = new Date();

    for (const row of missing) {
      await this.archiveRepository.update(
        { noticeNum: row.noticeNum },
        {
          lifecycleStatus: 'source_deleted',
          sourceDeletedAt: markedAt,
        },
      );

      const beforeSnapshot = this.buildTrackedSnapshot(row);
      const afterSnapshot = beforeSnapshot
        ? {
            ...beforeSnapshot,
            lifecycleStatus: 'source_deleted',
            sourceDeletedAt: markedAt.toISOString(),
          }
        : null;

      if (beforeSnapshot && afterSnapshot) {
        await this.appendExplicitEventWithDiff({
          noticeNum: row.noticeNum,
          source: 'archive:source-missing',
          eventType: 'invalidated',
          beforeSnapshot,
          afterSnapshot,
          subject: row.subject,
        });
      }
    }

    return missing.length;
  }

  /**
   * Returns one page of noticeNums that are currently marked isDone=true,
   * ordered by noticeNum ASC. Used by the revert pass to scan only the
   * records that could potentially need reverting - skips isDone=false rows
   * entirely.
   */
  async getDoneMarkedNumsPage(skip: number, take: number): Promise<number[]> {
    const rows = await this.archiveRepository.find({
      select: { noticeNum: true },
      where: { isDone: true },
      order: { noticeNum: 'ASC' },
      skip,
      take,
    });
    return rows.map((row) => row.noticeNum);
  }

  /**
   * Returns the first `take` archive rows whose `aiSummaryStatus` is
   * `'not_requested'`, ordered by `noticeNum` ascending.
   *
   * Intended for a **drain loop** - callers should always pass `skip=0`
   * because processed rows transition away from `'not_requested'` and
   * naturally drop out of subsequent calls.
   */
  async getPendingSummaryPage(take: number): Promise<CachedNotice[]> {
    const rows = await this.archiveRepository.find({
      where: { aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED },
      select: {
        noticeNum: true,
        subject: true,
        proposerCategory: true,
        committee: true,
        assemblyLink: true,
        contentId: true,
        proposalReason: true,
        attachmentPdfFile: true,
        attachmentHwpFile: true,
      },
      order: { noticeNum: 'ASC' },
      take,
    });

    return rows.map((row) =>
      mapArchiveEntityToCachedNotice(row, AI_SUMMARY_STATUS.NOT_REQUESTED),
    );
  }

  /**
   * Returns one page of archive rows whose `aiSummaryStatus` is `'unavailable'`,
   * ordered by `noticeNum` ascending.
   *
   * Intended for an **offset-based single-pass retry** - callers should
   * advance `skip` by the batch size on each iteration.  Unlike
   * `getPendingSummaryPage` this is NOT a drain loop: rows that remain
   * `'unavailable'` after a retry do not drop out of subsequent queries, so
   * the caller must increment `skip` to make forward progress.
   */
  async getUnavailableSummaryPage(
    skip: number,
    take: number,
  ): Promise<CachedNotice[]> {
    const rows = await this.archiveRepository.find({
      where: { aiSummaryStatus: AI_SUMMARY_STATUS.UNAVAILABLE },
      select: {
        noticeNum: true,
        subject: true,
        proposerCategory: true,
        committee: true,
        assemblyLink: true,
        contentId: true,
        proposalReason: true,
        attachmentPdfFile: true,
        attachmentHwpFile: true,
      },
      order: { noticeNum: 'ASC' },
      skip,
      take,
    });

    return rows.map((row) =>
      mapArchiveEntityToCachedNotice(row, AI_SUMMARY_STATUS.UNAVAILABLE),
    );
  }

  async getArchiveNotices(query: ArchiveListQuery): Promise<{
    items: ArchiveNoticeItem[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    search: string;
  }> {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(50, Math.max(1, query.limit || 10));
    const skip = (page - 1) * limit;
    const search = (query.search || '').trim();
    const where = buildArchiveWhereConditions({
      search,
      startDate: query.startDate,
      endDate: query.endDate,
      isDone: query.isDone,
      fullText: query.fullText,
    });
    const sortOrder = normalizeSortOrder(query.sortOrder);

    const [rows, total] = await this.archiveRepository.findAndCount({
      where,
      select: NOTICE_ITEM_SELECT,
      order: {
        noticeNum: sortOrder === 'asc' ? 'ASC' : 'DESC',
        archiveStartedAt: sortOrder === 'asc' ? 'ASC' : 'DESC',
      },
      skip,
      take: limit,
    });

    return {
      items: rows.map((row) => mapArchiveEntityToNoticeItem(row)),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      search,
    };
  }

  async listArchiveNotices(search?: string): Promise<ArchiveNoticeItem[]> {
    const normalizedSearch = (search || '').trim();
    const where = buildArchiveWhereConditions({
      search: normalizedSearch,
    });

    const rows = await this.archiveRepository.find({
      where,
      select: NOTICE_ITEM_SELECT,
      order: {
        archiveStartedAt: 'DESC',
        noticeNum: 'DESC',
      },
    });

    return rows.map((row) => mapArchiveEntityToNoticeItem(row));
  }

  async getArchiveNoticesByOffset(query: ArchiveOffsetQuery): Promise<{
    items: ArchiveNoticeItem[];
    total: number;
    search: string;
  }> {
    const skip = Math.max(0, query.skip || 0);
    const take = Math.max(0, query.take || 0);
    const search = (query.search || '').trim();
    const where = buildArchiveWhereConditions({
      search,
      startDate: query.startDate,
      endDate: query.endDate,
      isDone: query.isDone,
      fullText: query.fullText,
    });
    const sortOrder = normalizeSortOrder(query.sortOrder);

    // Use knownTotal when provided to avoid a redundant COUNT query.
    const total =
      query.knownTotal ?? (await this.archiveRepository.count({ where }));

    if (take === 0) {
      return {
        items: [],
        total,
        search,
      };
    }

    const rows = await this.archiveRepository.find({
      where,
      select: NOTICE_ITEM_SELECT,
      order: {
        noticeNum: sortOrder === 'asc' ? 'ASC' : 'DESC',
        archiveStartedAt: sortOrder === 'asc' ? 'ASC' : 'DESC',
      },
      skip,
      take,
    });

    return {
      items: rows.map((row) => mapArchiveEntityToNoticeItem(row)),
      total,
      search,
    };
  }

  async getArchivedNoticeDetail(
    noticeNum: number,
  ): Promise<ArchiveDetailResult | null> {
    return this.artifactSupport.getArchivedNoticeDetail(noticeNum);
  }

  async buildArchiveExportFile(
    noticeNum: number,
  ): Promise<ArchiveExportResult | null> {
    const changeTrackingData =
      await this.buildChangeTrackingExportData(noticeNum);
    return this.artifactSupport.buildArchiveExportFile(noticeNum, {
      changeTrackingData,
    });
  }

  async buildArchiveExportZip(
    noticeNum: number,
  ): Promise<{ zipFileName: string; zipBuffer: Buffer } | null> {
    const changeTrackingData =
      await this.buildChangeTrackingExportData(noticeNum);
    return this.artifactSupport.buildArchiveExportZip(noticeNum, {
      changeTrackingData,
    });
  }

  async flushQueuedChangeNotifications(): Promise<void> {
    if (!this.changeTrackingService) {
      return;
    }

    await this.changeTrackingService.flushQueuedChangeNotificationsNow();
  }

  beginChangeNotificationCollection(): void {
    this.changeTrackingService?.beginChangeNotificationCollection();
  }

  async endChangeNotificationCollection(): Promise<void> {
    if (!this.changeTrackingService) {
      return;
    }

    await this.changeTrackingService.endChangeNotificationCollection();
  }

  private async buildChangeTrackingExportData(noticeNum: number): Promise<any> {
    if (!this.changeTrackingService) {
      return null;
    }

    try {
      const events = await this.changeTrackingService.getNoticeChangeTimeline({
        noticeNum,
        limit: 1000,
      });

      return {
        exportedAt: new Date().toISOString(),
        noticeNum,
        eventCount: events.length,
        events,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to collect change-tracking export data for notice ${noticeNum}: ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        NoticeArchiveService.name,
        `Failed to collect change-tracking export data for notice ${noticeNum}: ${(error as Error).message}`,
        { noticeNum },
      );
      return {
        exportedAt: new Date().toISOString(),
        noticeNum,
        eventCount: 0,
        events: [],
        warning: 'change_tracking_unavailable',
      };
    }
  }

  async existsByNoticeNum(noticeNum: number): Promise<boolean> {
    return this.archiveRepository.exists({ where: { noticeNum } });
  }

  /**
   * Returns up to `limit` archived notices that have a contentId but no
   * screenshot yet, ordered oldest-first so early notices are backfilled first.
   * Used by the bootstrap screenshot-backfill pipeline.
   */
  async getNoticesWithMissingScreenshots(
    limit: number,
  ): Promise<Array<{ num: number; contentId: string; isDone: boolean }>> {
    const rows = await this.archiveRepository.find({
      select: { noticeNum: true, contentId: true, isDone: true },
      where: {
        screenshotBlob: IsNull(),
        contentId: Not(IsNull()),
      },
      order: { noticeNum: 'ASC' },
      take: limit,
    });

    return rows.map((row) => ({
      num: row.noticeNum,
      contentId: row.contentId!,
      isDone: row.isDone,
    }));
  }

  /**
   * Returns all pal.assembly.go.kr-sourced archived notices (contentId NOT NULL)
   * regardless of whether a screenshot has already been captured.
   * Used by the SCREENSHOT_REQUEUE_PAL startup flag to force a full re-capture.
   */
  async getAllPalNoticesForScreenshotRequeue(): Promise<
    Array<{ num: number; contentId: string; isDone: boolean }>
  > {
    const rows = await this.archiveRepository.find({
      select: { noticeNum: true, contentId: true, isDone: true },
      where: { contentId: Not(IsNull()) },
      order: { noticeNum: 'ASC' },
    });

    return rows.map((row) => ({
      num: row.noticeNum,
      contentId: row.contentId!,
      isDone: row.isDone,
    }));
  }

  /**
   * Returns up to `limit` NsmLmSts-sourced archived bills (contentId=null)
   * that are missing a screenshot, ordered oldest-first.
   * Used by the bootstrap screenshot-backfill pipeline.
   */
  async getNoticesWithMissingNsmScreenshots(
    limit: number,
  ): Promise<Array<{ num: number }>> {
    const rows = await this.archiveRepository.find({
      select: { noticeNum: true },
      where: {
        screenshotBlob: IsNull(),
        contentId: IsNull(),
      },
      order: { noticeNum: 'ASC' },
      take: limit,
    });

    return rows.map((row) => ({ num: row.noticeNum }));
  }

  /**
   * Returns the raw screenshot blob and its MIME format for the given notice,
   * or null if no screenshot has been captured yet.
   */
  async getScreenshotByNoticeNum(
    noticeNum: number,
  ): Promise<{ blob: Buffer; format: string } | null> {
    const row = await this.archiveRepository.findOne({
      where: { noticeNum },
      select: { screenshotBlob: true, screenshotFormat: true },
    });

    if (!row?.screenshotBlob) {
      return null;
    }

    return {
      blob: row.screenshotBlob,
      format: row.screenshotFormat ?? 'jpeg',
    };
  }

  /**
   * Stores (or replaces) the screenshot for an existing archive record.
   * Does nothing if no record with the given noticeNum exists.
   */
  async updateScreenshot(
    noticeNum: number,
    blob: Buffer,
    format: string,
  ): Promise<void> {
    await this.archiveRepository.update(
      { noticeNum },
      { screenshotBlob: blob, screenshotFormat: format },
    );
  }

  /**
   * Returns up to `limit` archived notices that need HTML/detail backfill,
   * split by source:
   *  - `pal`: pal.assembly.go.kr bills (contentId NOT NULL) with missing
   *    `sourceHtml`.
   *  - `nsm`: NsmLmSts bills (contentId IS NULL) with missing `sourceHtml`
   *    OR missing/empty `proposalReason`.
   *
   * Rows are ordered oldest-first so early notices are backfilled first.
   */
  async getNoticesWithMissingHtml(limit: number): Promise<{
    pal: Array<{ num: number; assemblyLink: string }>;
    nsm: Array<{ num: number }>;
  }> {
    const [palRows, nsmRows] = await Promise.all([
      this.archiveRepository.find({
        select: { noticeNum: true, assemblyLink: true },
        where: { sourceHtml: IsNull(), contentId: Not(IsNull()) },
        order: { noticeNum: 'ASC' },
        take: limit,
      }),
      this.archiveRepository
        .createQueryBuilder('na')
        .select('na.noticeNum', 'noticeNum')
        .where('na.contentId IS NULL')
        .andWhere(
          new Brackets((qb) => {
            qb.where('na.sourceHtml IS NULL')
              .orWhere('na.proposalReason IS NULL')
              .orWhere("TRIM(na.proposalReason) = ''");
          }),
        )
        .orderBy('na.noticeNum', 'ASC')
        .limit(limit)
        .getRawMany<{ noticeNum: number }>(),
    ]);

    return {
      pal: palRows.map((row) => ({
        num: row.noticeNum,
        assemblyLink: row.assemblyLink,
      })),
      nsm: nsmRows.map((row) => ({ num: row.noticeNum })),
    };
  }

  /**
   * Updates only the `sourceHtml`, `sourceHtmlSha256`, and HTTP-metadata
   * columns for a pal.assembly.go.kr notice.
   * Used by the HTML backfill pipeline to fill rows that were archived before
   * the source-HTML capture was added (or when the initial capture failed).
   */
  async updateSourceHtml(
    noticeNum: number,
    html: string,
    sha256: string,
    httpMetadata: ArchiveHttpMetadata | null,
  ): Promise<void> {
    const beforeRow = await this.getTrackedRowByNoticeNum(noticeNum);
    const normalized = httpMetadata || null;
    await this.archiveRepository.update(
      { noticeNum },
      {
        sourceHtml: html,
        sourceHtmlSha256: sha256,
        httpMetadataJson: normalized ? JSON.stringify(normalized) : null,
        httpFetchedAt: parseOptionalDate(normalized?.fetchedAt),
        httpStatusCode: normalized?.statusCode ?? null,
        httpContentType: normalized?.contentType ?? null,
        httpEtag: normalized?.etag ?? null,
        httpLastModified: normalized?.lastModified ?? null,
      },
    );

    const afterRow = await this.getTrackedRowByNoticeNum(noticeNum);
    await this.appendTrackedDiffEvent(
      noticeNum,
      'archive:updateSourceHtml',
      beforeRow,
      afterRow,
    );
  }

  /**
   * Updates `sourceHtml`, `sourceHtmlSha256`, `proposalReason`, HTTP-metadata,
   * and optionally `screenshotBlob` for a NsmLmSts bill in a single DB write.
   * Used by the HTML backfill pipeline when `captureNsmDetailFull` succeeds.
   * `screenshotBlob` is only written when explicitly provided (non-undefined).
   */
  async updateNsmHtmlAndDetail(
    noticeNum: number,
    payload: {
      html: string;
      sha256: string;
      proposalReason: string;
      httpMetadata: ArchiveHttpMetadata | null;
      screenshotBlob?: Buffer;
      screenshotFormat?: string;
    },
  ): Promise<void> {
    const beforeRow = await this.getTrackedRowByNoticeNum(noticeNum);
    const normalized = payload.httpMetadata || null;

    const baseUpdate: Partial<NoticeArchive> = {
      sourceHtml: payload.html,
      sourceHtmlSha256: payload.sha256,
      proposalReason: payload.proposalReason,
      httpMetadataJson: normalized ? JSON.stringify(normalized) : null,
      httpFetchedAt: parseOptionalDate(normalized?.fetchedAt),
      httpStatusCode: normalized?.statusCode ?? null,
      httpContentType: normalized?.contentType ?? null,
      httpEtag: normalized?.etag ?? null,
      httpLastModified: normalized?.lastModified ?? null,
    };

    if (payload.screenshotBlob !== undefined) {
      baseUpdate.screenshotBlob = payload.screenshotBlob;
      baseUpdate.screenshotFormat = payload.screenshotFormat ?? 'jpeg';
    }

    if (payload.proposalReason) {
      // When proposalReason is now populated, rows that were previously marked
      // 'not_supported' (because proposalReason was empty at archive time) must
      // be reset to `not_requested` so the summary backfill can pick them up.
      // Only rows still in the terminal-skip state are touched; rows that already
      // have a real status (ready / unavailable / not_requested) are left alone.
      await this.archiveRepository
        .createQueryBuilder()
        .update(NoticeArchive)
        .set({
          ...baseUpdate,
          aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED,
        })
        .where('noticeNum = :noticeNum AND aiSummaryStatus = :skip', {
          noticeNum,
          skip: 'not_supported',
        })
        .execute();

      // For rows whose aiSummaryStatus is already something other than
      // 'not_supported', update only the HTML/detail fields without touching
      // the status.
      await this.archiveRepository
        .createQueryBuilder()
        .update(NoticeArchive)
        .set(baseUpdate)
        .where('noticeNum = :noticeNum AND aiSummaryStatus != :skip', {
          noticeNum,
          skip: 'not_supported',
        })
        .execute();
    } else {
      await this.archiveRepository.update({ noticeNum }, baseUpdate);
    }

    const afterRow = await this.getTrackedRowByNoticeNum(noticeNum);
    await this.appendTrackedDiffEvent(
      noticeNum,
      'archive:updateNsmHtmlAndDetail',
      beforeRow,
      afterRow,
    );
  }

  private async getTrackedRowByNoticeNum(
    noticeNum: number,
  ): Promise<TrackedArchiveRow | null> {
    return this.archiveRepository.findOne({
      where: { noticeNum },
      select: {
        noticeNum: true,
        subject: true,
        proposerCategory: true,
        committee: true,
        proposalReason: true,
        contentBillNumber: true,
        contentProposer: true,
        contentProposalDate: true,
        contentCommittee: true,
        contentReferralDate: true,
        contentNoticePeriod: true,
        contentProposalSession: true,
        isDone: true,
        lifecycleStatus: true,
        sourceDeletedAt: true,
      },
    });
  }

  private async getTrackedRowByStableIdentity(
    incomingNoticeNum: number,
    contentId: string | null,
    billNumber: string | null,
  ): Promise<TrackedArchiveRow | null> {
    const where: FindOptionsWhere<NoticeArchive>[] = [];

    if (contentId) {
      where.push({ contentId });
    }

    if (billNumber) {
      where.push({ contentBillNumber: billNumber });
    }

    if (where.length === 0) {
      return null;
    }

    const matched = await this.archiveRepository.findOne({
      where,
      select: {
        noticeNum: true,
        subject: true,
        proposerCategory: true,
        committee: true,
        proposalReason: true,
        contentBillNumber: true,
        contentProposer: true,
        contentProposalDate: true,
        contentCommittee: true,
        contentReferralDate: true,
        contentNoticePeriod: true,
        contentProposalSession: true,
        isDone: true,
        lifecycleStatus: true,
        sourceDeletedAt: true,
      },
      order: { noticeNum: 'DESC' },
    });

    if (!matched || matched.noticeNum === incomingNoticeNum) {
      return null;
    }

    return matched;
  }

  private buildTrackedSnapshot(
    row: TrackedArchiveRow | null,
  ): Record<string, unknown> | null {
    if (!row) return null;

    return {
      num: row.noticeNum,
      subject: row.subject,
      proposerCategory: row.proposerCategory,
      committee: row.committee,
      proposalReason: row.proposalReason,
      billNumber: row.contentBillNumber,
      proposer: row.contentProposer,
      proposalDate: row.contentProposalDate,
      contentCommittee: row.contentCommittee,
      referralDate: row.contentReferralDate,
      noticePeriod: row.contentNoticePeriod,
      proposalSession: row.contentProposalSession,
      isDone: row.isDone,
      lifecycleStatus: row.lifecycleStatus,
      sourceDeletedAt: row.sourceDeletedAt
        ? row.sourceDeletedAt.toISOString()
        : null,
    };
  }

  private async appendTrackedDiffEvent(
    noticeNum: number,
    source: string,
    beforeRow: TrackedArchiveRow | null,
    afterRow: TrackedArchiveRow | null,
  ): Promise<void> {
    if (!this.changeTrackingService || !afterRow) {
      return;
    }

    try {
      const beforeSnapshot = this.buildTrackedSnapshot(beforeRow);
      const afterSnapshot = this.buildTrackedSnapshot(afterRow);
      if (!afterSnapshot) return;

      const built = this.changeTrackingService.buildDiffEvent({
        noticeNum,
        beforeSnapshot,
        afterSnapshot,
        source,
      });

      if (!built.shouldAppend) {
        return;
      }

      const event =
        await this.changeTrackingService.appendChangeEventWithDetails({
          noticeNum,
          eventType: built.eventType,
          eventHash: built.eventHash,
          detectedAt: built.detectedAt,
          source,
          changedFieldCount: built.diff.changedFieldCount,
          diffSummaryJson: built.diff.diffSummaryJson,
          hashAlgo: built.hashAlgo,
          canonVersion: built.canonVersion,
          details: built.diff.details.map((detail) => ({
            fieldPath: detail.fieldPath,
            changeType: detail.changeType,
            beforeValue: detail.beforeValue,
            afterValue: detail.afterValue,
            beforeHash: detail.beforeHash,
            afterHash: detail.afterHash,
          })),
        });

      const subject =
        typeof afterSnapshot.subject === 'string'
          ? afterSnapshot.subject
          : `notice-${noticeNum}`;

      void this.changeTrackingService
        .dispatchChangeNotification({
          event,
          subject,
          changedFields: built.diff.details.map((detail) => detail.fieldPath),
        })
        .catch((dispatchError) => {
          this.logger.warn(
            `Failed to dispatch change notification for event ${event.id}: ${(dispatchError as Error).message}`,
          );
          void this.discordBridge?.logEvent(
            BridgeLogLevel.WARN,
            NoticeArchiveService.name,
            `Failed to dispatch change notification for event ${event.id}: ${(dispatchError as Error).message}`,
            { eventId: event.id, noticeNum },
          );
        });
    } catch (error) {
      this.logger.warn(
        `Failed to append change event for notice ${noticeNum} (${source}): ${(error as Error).message}`,
      );
      void this.discordBridge?.logEvent(
        BridgeLogLevel.WARN,
        NoticeArchiveService.name,
        `Failed to append change event for notice ${noticeNum} (${source}): ${(error as Error).message}`,
        { noticeNum, source },
      );
      throw error;
    }
  }

  private async appendExplicitEventWithDiff(input: {
    noticeNum: number;
    source: string;
    eventType: Extract<ChangeEventType, 'invalidated' | 'redacted'>;
    beforeSnapshot: Record<string, unknown> | null;
    afterSnapshot: Record<string, unknown>;
    subject: string;
  }): Promise<void> {
    if (!this.changeTrackingService) {
      return;
    }

    const hashAlgo = 'sha256';
    const canonVersion = 1;
    const detectedAt = new Date();
    const diff = computeDiff(input.beforeSnapshot, input.afterSnapshot);

    if (!diff.changed) {
      return;
    }

    const eventHash = sha256Hex(
      canonicalStringify({
        noticeNum: input.noticeNum,
        detectedAt: detectedAt.toISOString(),
        eventType: input.eventType,
        source: input.source,
        hashAlgo,
        canonVersion,
        before: diff.normalizedBefore,
        after: diff.normalizedAfter,
        details: diff.details,
      }),
    );

    const event = await this.changeTrackingService.appendChangeEventWithDetails(
      {
        noticeNum: input.noticeNum,
        eventType: input.eventType,
        eventHash,
        detectedAt,
        source: input.source,
        changedFieldCount: diff.changedFieldCount,
        diffSummaryJson: diff.diffSummaryJson,
        hashAlgo,
        canonVersion,
        details: diff.details.map((detail) => ({
          fieldPath: detail.fieldPath,
          changeType: detail.changeType,
          beforeValue: detail.beforeValue,
          afterValue: detail.afterValue,
          beforeHash: detail.beforeHash,
          afterHash: detail.afterHash,
        })),
      },
    );

    void this.changeTrackingService
      .dispatchChangeNotification({
        event,
        subject: input.subject,
        changedFields: diff.details.map((detail) => detail.fieldPath),
      })
      .catch((dispatchError) => {
        this.logger.warn(
          `Failed to dispatch explicit ${input.eventType} notification for notice ${input.noticeNum}: ${(dispatchError as Error).message}`,
        );
      });
  }

  async getExistingNoticeNumSet(noticeNums: number[]): Promise<Set<number>> {
    const uniqueNums = Array.from(new Set(noticeNums));

    if (uniqueNums.length === 0) {
      return new Set();
    }

    const rows = await this.archiveRepository.find({
      where: {
        noticeNum: In(uniqueNums),
      },
      select: {
        noticeNum: true,
      },
    });

    return new Set(rows.map((row) => row.noticeNum));
  }

  /**
   * Returns the subset of the given notice numbers that exist in the archive
   * with a NULL contentId (i.e. records sourced from NsmLmSts pending sync
   * that have not yet been enriched with a pal.assembly.go.kr contentId).
   */
  async getArchivedNullContentIdNums(nums: number[]): Promise<Set<number>> {
    if (nums.length === 0) return new Set();

    const uniqueNums = Array.from(new Set(nums));
    const rows = await this.archiveRepository.find({
      where: { noticeNum: In(uniqueNums), contentId: IsNull() },
      select: { noticeNum: true },
    });
    return new Set(rows.map((row) => row.noticeNum));
  }

  /**
   * Upgrades previously-pending archive records (contentId=NULL) with the
   * pal.assembly.go.kr contentId, updated assembly link, and committee once
   * those bills appear in the \uc785\ubc95\uc608\uace0 system.
   *
   * Only rows that still have contentId=NULL are touched to avoid overwriting
   * a contentId that may have been set by a concurrent archive cycle.
   *
   * @returns The number of rows actually updated.
   */
  async upgradePendingNotices(
    items: Array<{
      num: number;
      contentId: string;
      link: string;
      committee: string;
    }>,
  ): Promise<number> {
    if (items.length === 0) return 0;

    const updatedCounts = await mapConcurrently(items, 10, async (item) => {
      const result = await this.archiveRepository.update(
        { noticeNum: item.num, contentId: IsNull() },
        {
          contentId: item.contentId,
          assemblyLink: item.link,
          committee: item.committee,
        },
      );
      return result.affected ?? 0;
    });

    return updatedCounts.reduce((sum, count) => sum + count, 0);
  }

  async getArchiveCount(): Promise<number> {
    return this.archiveRepository.count();
  }

  /**
   * Returns the most recent active (isDone=false) archive rows as CachedNotice objects,
   * ordered newest-first by noticeNum. Intended exclusively for bootstrap cache
   * initialization - avoids a redundant full crawl when the archive already has data.
   *
   * The returned notices include their persisted aiSummary / aiSummaryStatus so
   * the cache is immediately populated with the latest known summary state without
   * any Ollama calls.
   */
  async getRecentNoticesForCache(limit: number): Promise<CachedNotice[]> {
    const rows = await this.archiveRepository.find({
      select: {
        noticeNum: true,
        subject: true,
        proposerCategory: true,
        committee: true,
        assemblyLink: true,
        contentId: true,
        attachmentPdfFile: true,
        attachmentHwpFile: true,
        aiSummary: true,
        aiSummaryStatus: true,
      },
      where: { isDone: false },
      order: { noticeNum: 'DESC' },
      take: limit,
    });

    return rows.map((row) =>
      mapArchiveEntityToCachedNotice(row, 'not_requested'),
    );
  }

  /**
   * Paginates through every archive record and verifies its stored SHA-256
   * hash against a freshly computed hash of `sourceHtml`.  Results are
   * persisted back to `integrityVerifiedAt` / `integrityCheckPassed` so
   * subsequent detail views reflect the latest check.
   *
   * Rows without `sourceHtml` or `sourceHtmlSha256` are counted as skipped.
   *
   * @param batchSize Number of rows fetched per round-trip (default 200).
   * @param forceUpdate When `true`, always writes `integrityVerifiedAt` even
   *   when the result is unchanged. Use for scheduled re-validation passes so
   *   the timestamp always reflects the most recent check time.
   */
  async runIntegrityScan(
    batchSize = 200,
    forceUpdate = false,
  ): Promise<{
    scanned: number;
    passed: number;
    failed: number;
    skipped: number;
  }> {
    return this.artifactSupport.runIntegrityScan(batchSize, forceUpdate);
  }

  async getArchiveStartedAtByNoticeNums(
    noticeNums: number[],
  ): Promise<Map<number, Date>> {
    const uniqueNums = Array.from(new Set(noticeNums));

    if (uniqueNums.length === 0) {
      return new Map();
    }

    const rows = await this.archiveRepository.find({
      where: {
        noticeNum: In(uniqueNums),
      },
      select: {
        noticeNum: true,
        archiveStartedAt: true,
      },
    });

    return new Map(rows.map((row) => [row.noticeNum, row.archiveStartedAt]));
  }

  async countByNoticeNumComparison(
    query: ArchiveNumCompareCountQuery,
  ): Promise<number> {
    const where = buildArchiveWhereConditions({
      search: query.search,
      startDate: query.startDate,
      endDate: query.endDate,
      noticeNumCondition:
        query.operator === 'gt' ? MoreThan(query.num) : LessThan(query.num),
    });

    return this.archiveRepository.count({ where });
  }

  async getSummaryStateByNoticeNums(
    noticeNums: number[],
  ): Promise<Map<number, ArchiveSummaryState>> {
    const uniqueNums = Array.from(new Set(noticeNums));

    if (uniqueNums.length === 0) {
      return new Map();
    }

    const rows = await this.archiveRepository.find({
      where: {
        noticeNum: In(uniqueNums),
      },
      select: {
        noticeNum: true,
        aiSummary: true,
        aiSummaryStatus: true,
      },
    });

    return new Map(
      rows.map((row) => [
        row.noticeNum,
        {
          aiSummary: row.aiSummary ?? null,
          aiSummaryStatus: (row.aiSummaryStatus ||
            'not_requested') as AISummaryStatus,
        },
      ]),
    );
  }

  async updateSummaryStateByNoticeNum(
    noticeNum: number,
    summary: string | null,
    status: AISummaryStatus,
  ): Promise<void> {
    await this.archiveRepository.update(
      { noticeNum },
      {
        aiSummary: summary?.trim() ? summary : null,
        aiSummaryStatus: status,
      },
    );
  }
}
