import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
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
import { NoticeArchiveSummaryState } from './notice-archive-summary-state.entity';
import {
  NOTICE_ITEM_SELECT,
  buildArchiveWhereConditions,
  mapArchiveEntityToCachedNotice,
  mapArchiveEntityToNoticeItem,
  normalizeSortOrder,
  parseOptionalDate,
} from './notice-archive.helpers';
import { NoticeArchiveArtifactSupport } from './utils/notice-archive-artifact-support';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import { type ChangeEventType } from '../change-tracking/notice-change-event.entity';
import {
  canonicalStringify,
  computeDiff,
  DEFAULT_TRACKED_FIELDS,
  sha256Hex,
} from '../change-tracking/change-tracking-diff.utils';
import { NoticeChangeSource } from '../change-tracking/notice-change-source.enum';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../utils/logger.utils';

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
  changeEventCount?: number;
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

export interface LegacyGenesisSeedResult {
  boundaryAt: string;
  scanned: number;
  seeded: number;
  skipped: number;
}

export const LEGACY_GENESIS_SOURCE = NoticeChangeSource.BOOTSTRAP_LEGACY_SEED;

@Injectable()
export class NoticeArchiveService {
  private readonly logger = LoggerUtils.getContextLogger(
    NoticeArchiveService.name,
  );
  private readonly artifactSupport: NoticeArchiveArtifactSupport;
  private readonly revisionTrackedFieldPaths = [
    ...DEFAULT_TRACKED_FIELDS,
    // Accept legacy/alias field keys emitted across NSM -> PAL transition paths.
    'contentBillNumber',
    'contentProposer',
    'contentProposalDate',
    'contentReferralDate',
    'contentNoticePeriod',
    'contentProposalSession',
  ] as const;

  constructor(
    @InjectRepository(NoticeArchive)
    private readonly archiveRepository: Repository<NoticeArchive>,
    @Optional()
    @InjectRepository(NoticeArchiveSummaryState)
    private readonly summaryStateRepository?: Repository<NoticeArchiveSummaryState>,
    @Optional()
    private readonly changeTrackingService?: ChangeTrackingService,
    @Optional() private readonly discordBridge?: DiscordBridgeService,
  ) {
    this.artifactSupport = new NoticeArchiveArtifactSupport(
      this.archiveRepository,
      this.summaryStateRepository,
    );

    if (!this.changeTrackingService) {
      const message =
        'ChangeTrackingService is required for immutable diffchain mode.';
      this.logger.error(message);
      throw new Error(message);
    }
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

  private normalizeProposalReasonText(
    value: string | null | undefined,
  ): string | null {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized && normalized.length > 0 ? normalized : null;
  }

  async seedLegacyGenesisEvents(
    boundaryAt: Date,
    batchSize = 300,
  ): Promise<LegacyGenesisSeedResult> {
    if (!this.changeTrackingService) {
      return {
        boundaryAt: boundaryAt.toISOString(),
        scanned: 0,
        seeded: 0,
        skipped: 0,
      };
    }

    const take = Math.max(1, Math.min(batchSize, 2000));
    let skip = 0;
    let scanned = 0;
    let seeded = 0;
    let skipped = 0;

    while (true) {
      const rows = await this.getGenesisCandidateRows(skip, take);
      if (rows.length === 0) {
        break;
      }

      scanned += rows.length;

      const existingEventNoticeNums =
        await this.changeTrackingService.getNoticeNumsWithAnyEvent(
          rows.map((row) => row.noticeNum),
        );

      for (const row of rows) {
        if (existingEventNoticeNums.has(row.noticeNum)) {
          skipped += 1;
          continue;
        }

        const afterSnapshot = this.buildTrackedSnapshot(row);
        if (!afterSnapshot) {
          skipped += 1;
          continue;
        }

        const diff = computeDiff(null, afterSnapshot);

        const eventHash = sha256Hex(
          canonicalStringify({
            noticeNum: row.noticeNum,
            detectedAt: boundaryAt.toISOString(),
            eventType: 'created',
            source: LEGACY_GENESIS_SOURCE,
            hashAlgo: 'sha256',
            canonVersion: 1,
            before: diff.normalizedBefore,
            after: diff.normalizedAfter,
            details: diff.details,
          }),
        );

        const event =
          await this.changeTrackingService.appendChangeEventWithDetails({
            noticeNum: row.noticeNum,
            eventType: 'created',
            eventHash,
            detectedAt: boundaryAt,
            source: LEGACY_GENESIS_SOURCE,
            changedFieldCount: diff.changedFieldCount,
            diffSummaryJson: diff.diffSummaryJson,
            hashAlgo: 'sha256',
            canonVersion: 1,
            details: diff.details.map((detail) => ({
              fieldPath: detail.fieldPath,
              changeType: detail.changeType,
              beforeValue: detail.beforeValue,
              afterValue: detail.afterValue,
              beforeHash: detail.beforeHash,
              afterHash: detail.afterHash,
            })),
          });

        if (!event?.id) {
          skipped += 1;
          continue;
        }

        seeded += 1;
      }

      skip += rows.length;
    }

    return {
      boundaryAt: boundaryAt.toISOString(),
      scanned,
      seeded,
      skipped,
    };
  }

  private async getGenesisCandidateRows(
    skip: number,
    take: number,
  ): Promise<TrackedArchiveRow[]> {
    return this.archiveRepository.find({
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
      order: { noticeNum: 'ASC' },
      skip,
      take,
    });
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
    const hasExplicitSummary =
      Object.prototype.hasOwnProperty.call(notice, 'aiSummary') ||
      Object.prototype.hasOwnProperty.call(notice, 'aiSummaryStatus');
    const summaryStatus =
      notice.aiSummaryStatus ?? AI_SUMMARY_STATUS.NOT_REQUESTED;
    const summaryPayload = {
      aiSummary: notice.aiSummary ?? null,
      aiSummaryStatus: summaryStatus,
    };

    if (isRenumbering && beforeRow) {
      const beforeSnapshot = this.buildTrackedSnapshot(beforeRow);
      if (beforeSnapshot) {
        const invalidatedSnapshot = {
          ...beforeSnapshot,
          lifecycleStatus: 'renumbered',
        };
        await this.appendExplicitEventWithDiff({
          noticeNum: previousNoticeNum,
          source: NoticeChangeSource.ARCHIVE_RENUMBERED,
          eventType: 'invalidated',
          beforeSnapshot,
          afterSnapshot: invalidatedSnapshot,
          subject: beforeRow.subject,
        });
      }
    }

    if (existing) {
      // Strict immutability: existing archive rows are never updated.
      // Any observed changes are represented only as appended diffchain events.
    } else {
      await this.archiveRepository.save(
        this.archiveRepository.create({
          ...coreFields,
          screenshotBlob: originalContent.screenshotBlob ?? null,
          screenshotFormat: originalContent.screenshotFormat ?? null,
        }),
      );
    }

    if (this.summaryStateRepository) {
      if (isRenumbering && previousNoticeNum !== null) {
        const previousSummaryState = await this.summaryStateRepository.findOne({
          where: { noticeNum: previousNoticeNum },
          select: {
            aiSummary: true,
            aiSummaryStatus: true,
          },
        });

        if (previousSummaryState) {
          await this.summaryStateRepository.upsert(
            {
              noticeNum: notice.num,
              aiSummary: previousSummaryState.aiSummary ?? null,
              aiSummaryStatus: previousSummaryState.aiSummaryStatus,
            },
            ['noticeNum'],
          );

          await this.summaryStateRepository.delete({
            noticeNum: previousNoticeNum,
          });
        }
      }

      if (hasExplicitSummary) {
        await this.summaryStateRepository.upsert(
          {
            noticeNum: notice.num,
            ...summaryPayload,
          },
          ['noticeNum'],
        );
      } else {
        await this.summaryStateRepository
          .createQueryBuilder()
          .insert()
          .values({
            noticeNum: notice.num,
            aiSummary: null,
            aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED,
          })
          .orIgnore()
          .execute();
      }
    } else {
      // Strict immutability: keep summary state outside notice_archives.
      // When summary_state table is unavailable we intentionally skip write.
    }

    await this.appendTrackedDiffEvent(
      notice.num,
      NoticeChangeSource.ARCHIVE_UPSERT,
      beforeRow,
      {
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
      },
    );
  }

  /**
   * Bulk-updates archive records matching the given notice numbers to isDone=true.
   * Records already marked as done are not touched.
   * @returns Number of rows actually changed
   */
  async markNoticesDoneByNums(nums: number[]): Promise<number> {
    void nums;
    return 0;
  }

  /**
   * Bulk-reverts archive records matching the given notice numbers to isDone=false.
   * Records already marked as active are not touched.
   * @returns Number of rows actually changed
   */
  async revertNoticesDoneByNums(nums: number[]): Promise<number> {
    void nums;
    return 0;
  }

  async markSourceDeletedByMissingPalNums(
    seenPalActiveNums: Set<number>,
  ): Promise<number> {
    void seenPalActiveNums;
    return 0;
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
    const rows = this.summaryStateRepository
      ? await this.archiveRepository
          .createQueryBuilder('archive')
          .innerJoin(
            NoticeArchiveSummaryState,
            'summary',
            'summary.notice_num = archive.noticeNum',
          )
          .select([
            'archive.noticeNum AS noticeNum',
            'archive.subject AS subject',
            'archive.proposerCategory AS proposerCategory',
            'archive.committee AS committee',
            'archive.assemblyLink AS assemblyLink',
            'archive.contentId AS contentId',
            'archive.proposalReason AS proposalReason',
            'archive.attachmentPdfFile AS attachmentPdfFile',
            'archive.attachmentHwpFile AS attachmentHwpFile',
            'summary.aiSummary AS aiSummary',
            'summary.aiSummaryStatus AS aiSummaryStatus',
          ])
          .where('summary.aiSummaryStatus = :status', {
            status: AI_SUMMARY_STATUS.NOT_REQUESTED,
          })
          .orderBy('archive.noticeNum', 'ASC')
          .take(take)
          .getRawMany<{
            noticeNum: number;
            subject: string;
            proposerCategory: string;
            committee: string;
            assemblyLink: string;
            contentId: string | null;
            proposalReason: string | null;
            attachmentPdfFile: string | null;
            attachmentHwpFile: string | null;
            aiSummary: string | null;
            aiSummaryStatus: AISummaryStatus;
          }>()
      : await this.archiveRepository.find({
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

    if (this.summaryStateRepository) {
      return rows.map((row) =>
        mapArchiveEntityToCachedNotice(
          {
            noticeNum: row.noticeNum,
            subject: row.subject,
            proposerCategory: row.proposerCategory,
            committee: row.committee,
            assemblyLink: row.assemblyLink,
            contentId: row.contentId,
            proposalReason: row.proposalReason ?? '',
            attachmentPdfFile: row.attachmentPdfFile ?? '',
            attachmentHwpFile: row.attachmentHwpFile ?? '',
            aiSummary: row.aiSummary,
            aiSummaryStatus: row.aiSummaryStatus,
          },
          AI_SUMMARY_STATUS.NOT_REQUESTED,
        ),
      );
    }

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
    const rows = this.summaryStateRepository
      ? await this.archiveRepository
          .createQueryBuilder('archive')
          .innerJoin(
            NoticeArchiveSummaryState,
            'summary',
            'summary.notice_num = archive.noticeNum',
          )
          .select([
            'archive.noticeNum AS noticeNum',
            'archive.subject AS subject',
            'archive.proposerCategory AS proposerCategory',
            'archive.committee AS committee',
            'archive.assemblyLink AS assemblyLink',
            'archive.contentId AS contentId',
            'archive.proposalReason AS proposalReason',
            'archive.attachmentPdfFile AS attachmentPdfFile',
            'archive.attachmentHwpFile AS attachmentHwpFile',
            'summary.aiSummary AS aiSummary',
            'summary.aiSummaryStatus AS aiSummaryStatus',
          ])
          .where('summary.aiSummaryStatus = :status', {
            status: AI_SUMMARY_STATUS.UNAVAILABLE,
          })
          .orderBy('archive.noticeNum', 'ASC')
          .skip(skip)
          .take(take)
          .getRawMany<{
            noticeNum: number;
            subject: string;
            proposerCategory: string;
            committee: string;
            assemblyLink: string;
            contentId: string | null;
            proposalReason: string | null;
            attachmentPdfFile: string | null;
            attachmentHwpFile: string | null;
            aiSummary: string | null;
            aiSummaryStatus: AISummaryStatus;
          }>()
      : await this.archiveRepository.find({
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

    if (this.summaryStateRepository) {
      return rows.map((row) =>
        mapArchiveEntityToCachedNotice(
          {
            noticeNum: row.noticeNum,
            subject: row.subject,
            proposerCategory: row.proposerCategory,
            committee: row.committee,
            assemblyLink: row.assemblyLink,
            contentId: row.contentId,
            proposalReason: row.proposalReason ?? '',
            attachmentPdfFile: row.attachmentPdfFile ?? '',
            attachmentHwpFile: row.attachmentHwpFile ?? '',
            aiSummary: row.aiSummary,
            aiSummaryStatus: row.aiSummaryStatus,
          },
          AI_SUMMARY_STATUS.UNAVAILABLE,
        ),
      );
    }

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

    if (this.summaryStateRepository && rows.length > 0) {
      const summaryStates = await this.getSummaryStateByNoticeNums(
        rows.map((row) => row.noticeNum),
      );

      for (const row of rows) {
        const summaryState = summaryStates.get(row.noticeNum);
        if (!summaryState) continue;
        row.aiSummary = summaryState.aiSummary;
        row.aiSummaryStatus = summaryState.aiSummaryStatus;
      }
    }

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

    if (this.summaryStateRepository && rows.length > 0) {
      const summaryStates = await this.getSummaryStateByNoticeNums(
        rows.map((row) => row.noticeNum),
      );

      for (const row of rows) {
        const summaryState = summaryStates.get(row.noticeNum);
        if (!summaryState) continue;
        row.aiSummary = summaryState.aiSummary;
        row.aiSummaryStatus = summaryState.aiSummaryStatus;
      }
    }

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

  async getArchivedNoticeDetailWithRevision(
    noticeNum: number,
    revRaw?: string,
  ): Promise<{
    detail: ArchiveDetailResult;
    revision: {
      requestedRev: number | null;
      resolvedRev: number | null;
      headRev: number | null;
      hasDiffchain: boolean;
      isHistorical: boolean;
      hasLegacyGenesisBoundary: boolean;
      legacyGenesisBoundaryAt: Date | null;
    };
  }> {
    const detail = await this.getArchivedNoticeDetail(noticeNum);
    if (!detail) {
      throw new NotFoundException(
        `의안번호 ${noticeNum}에 해당하는 아카이브 입법예고를 찾을 수 없습니다.`,
      );
    }

    const timeline = this.changeTrackingService
      ? await this.changeTrackingService.getNoticeChangeTimeline({
          noticeNum,
          limit: 1000,
        })
      : [];

    const eventsAsc = [...timeline].sort(
      (a, b) => a.eventHeight - b.eventHeight,
    );
    const headRev =
      eventsAsc.length > 0 ? eventsAsc[eventsAsc.length - 1].eventHeight : null;
    const requestedRev = this.parseRevisionQuery(revRaw);

    if (requestedRev !== null && (headRev === null || requestedRev > headRev)) {
      throw new BadRequestException(
        `요청하신 리비전이 유효하지 않습니다. requested_rev=${requestedRev}, head_rev=${headRev ?? 0}`,
      );
    }

    const resolvedRev = requestedRev ?? headRev;
    const detailWithRevision = this.applyRevisionOverlay(
      detail,
      eventsAsc,
      resolvedRev,
    );
    const legacyGenesisEvent = eventsAsc.find(
      (event) => event.source === NoticeChangeSource.BOOTSTRAP_LEGACY_SEED,
    );

    return {
      detail: detailWithRevision,
      revision: {
        requestedRev,
        resolvedRev,
        headRev,
        hasDiffchain: headRev !== null,
        isHistorical:
          resolvedRev !== null && headRev !== null && resolvedRev < headRev,
        hasLegacyGenesisBoundary: Boolean(legacyGenesisEvent),
        legacyGenesisBoundaryAt: legacyGenesisEvent?.detectedAt ?? null,
      },
    };
  }

  private parseRevisionQuery(revRaw?: string): number | null {
    if (revRaw === undefined || revRaw === null || revRaw.trim() === '') {
      return null;
    }

    const parsed = Number.parseInt(revRaw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('rev 파라미터는 1 이상의 정수여야 합니다.');
    }

    return parsed;
  }

  private applyRevisionOverlay(
    base: ArchiveDetailResult,
    eventsAsc: Awaited<
      ReturnType<ChangeTrackingService['getNoticeChangeTimeline']>
    >,
    targetRev: number | null,
  ): ArchiveDetailResult {
    const copied: ArchiveDetailResult = {
      ...base,
      notice: {
        ...base.notice,
        attachments: { ...base.notice.attachments },
      },
      originalContent: { ...base.originalContent },
      archiveMetadata: {
        ...base.archiveMetadata,
        integrity: { ...base.archiveMetadata.integrity },
        http: { ...base.archiveMetadata.http },
      },
      screenshotMeta: { ...base.screenshotMeta },
    };

    const timelineState = new Map<string, string | null>(
      this.revisionTrackedFieldPaths.map((fieldPath) => [fieldPath, null]),
    );
    const firstSeenEventHeight = new Map<string, number>();

    for (const event of eventsAsc) {
      for (const detail of event.details) {
        if (!timelineState.has(detail.fieldPath)) {
          continue;
        }

        if (!firstSeenEventHeight.has(detail.fieldPath)) {
          firstSeenEventHeight.set(detail.fieldPath, event.eventHeight);
        }

        if (targetRev === null || event.eventHeight <= targetRev) {
          timelineState.set(detail.fieldPath, detail.afterValue);
        }
      }

      if (targetRev !== null && event.eventHeight > targetRev) {
        break;
      }
    }

    for (const fieldPath of this.revisionTrackedFieldPaths) {
      const seenAt = firstSeenEventHeight.get(fieldPath);

      // Legacy chains may not include some fields at all. Keep base values for
      // never-seen fields instead of forcing null.
      if (seenAt === undefined) {
        continue;
      }

      // If a field first appears after targetRev, it did not exist yet at that
      // historical point, so force it to null.
      if (targetRev !== null && targetRev < seenAt) {
        this.applyTrackedValue(copied, fieldPath, null);
        continue;
      }

      this.applyTrackedValue(
        copied,
        fieldPath,
        timelineState.get(fieldPath) ?? null,
      );
    }

    return copied;
  }

  private applyTrackedValue(
    detail: ArchiveDetailResult,
    fieldPath: string,
    value: string | null,
  ): void {
    const toStringOrNull = (raw: string | null): string | null => {
      if (raw === null) return null;
      const normalized = raw.trim();
      return normalized.length > 0 ? normalized : null;
    };

    const toBooleanOrNull = (raw: string | null): boolean | null => {
      const normalized = toStringOrNull(raw)?.toLowerCase();
      if (!normalized) return null;
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      return null;
    };

    switch (fieldPath) {
      case 'num': {
        const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          detail.notice.num = parsed;
        }
        return;
      }
      case 'subject':
        detail.notice.subject = value ?? '';
        return;
      case 'proposerCategory':
        detail.notice.proposerCategory = value ?? '';
        return;
      case 'committee':
        detail.notice.committee = value ?? '';
        return;
      case 'proposalReason':
        detail.originalContent.proposalReason = value ?? '';
        return;
      case 'billNumber':
      case 'contentBillNumber':
        detail.originalContent.billNumber = toStringOrNull(value);
        return;
      case 'proposer':
      case 'contentProposer':
        detail.originalContent.proposer = toStringOrNull(value);
        return;
      case 'proposalDate':
      case 'contentProposalDate':
        detail.originalContent.proposalDate = toStringOrNull(value);
        return;
      case 'contentCommittee':
        detail.originalContent.committee = toStringOrNull(value);
        return;
      case 'referralDate':
      case 'contentReferralDate':
        detail.originalContent.referralDate = toStringOrNull(value);
        return;
      case 'noticePeriod':
      case 'contentNoticePeriod':
        detail.originalContent.noticePeriod = toStringOrNull(value);
        return;
      case 'proposalSession':
      case 'contentProposalSession':
        detail.originalContent.proposalSession = toStringOrNull(value);
        return;
      case 'isDone': {
        const parsed = toBooleanOrNull(value);
        if (parsed !== null) {
          detail.notice.isDone = parsed;
        }
        return;
      }
      case 'lifecycleStatus': {
        const normalized = toStringOrNull(value);
        if (
          normalized === 'active' ||
          normalized === 'source_deleted' ||
          normalized === 'renumbered'
        ) {
          detail.notice.lifecycleStatus = normalized;
        }
        return;
      }
      case 'sourceDeletedAt': {
        const normalized = toStringOrNull(value);
        if (!normalized) {
          detail.notice.sourceDeletedAt = null;
          return;
        }

        const parsed = new Date(normalized);
        detail.notice.sourceDeletedAt = Number.isNaN(parsed.getTime())
          ? null
          : parsed;
        return;
      }
      default:
        return;
    }
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

  beginChangeNotificationSuppression(): void {
    this.changeTrackingService?.beginChangeNotificationSuppression();
  }

  async endChangeNotificationCollection(): Promise<void> {
    if (!this.changeTrackingService) {
      return;
    }

    await this.changeTrackingService.endChangeNotificationCollection();
  }

  endChangeNotificationSuppression(): void {
    this.changeTrackingService?.endChangeNotificationSuppression();
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
    void noticeNum;
    void blob;
    void format;
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
    void noticeNum;
    void html;
    void sha256;
    void httpMetadata;
  }

  /**
   * Updates `sourceHtml`, `sourceHtmlSha256`, HTTP-metadata, and optionally
   * `screenshotBlob` for a NsmLmSts bill in a single DB write.
   * Used by the HTML backfill pipeline when `captureNsmDetailFull` succeeds.
   * `proposalReason` is intentionally kept out of the archive row so it can be
   * recorded as an append-only change event instead of mutating the snapshot.
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
    if (!beforeRow) {
      return;
    }

    const beforeSnapshot = this.buildTrackedSnapshot(beforeRow);
    if (!beforeSnapshot) {
      return;
    }

    const latestProposalReason =
      await this.getLatestProposalReasonForNotice(noticeNum);
    const normalizedLatestProposalReason =
      this.normalizeProposalReasonText(latestProposalReason);
    const normalizedProposalReason = this.normalizeProposalReasonText(
      payload.proposalReason,
    );

    if (!normalizedProposalReason) {
      return;
    }

    // Use chain-head value as the effective baseline to avoid re-appending
    // semantically identical proposalReason changes from immutable archive rows.
    const effectiveBeforeSnapshot = {
      ...beforeSnapshot,
      proposalReason:
        normalizedLatestProposalReason ??
        this.normalizeProposalReasonText(
          typeof beforeSnapshot.proposalReason === 'string'
            ? beforeSnapshot.proposalReason
            : null,
        ) ??
        '',
    };

    if (normalizedProposalReason !== effectiveBeforeSnapshot.proposalReason) {
      const afterSnapshot = {
        ...beforeSnapshot,
        proposalReason: normalizedProposalReason,
      };

      await this.appendExplicitEventWithDiff({
        noticeNum,
        source: NoticeChangeSource.ARCHIVE_UPDATE_NSM_HTML_AND_DETAIL,
        eventType: 'updated',
        beforeSnapshot: effectiveBeforeSnapshot,
        afterSnapshot,
        subject: beforeRow.subject,
      });
    }
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
    source: NoticeChangeSource,
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
    source: NoticeChangeSource;
    eventType: ChangeEventType;
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
   * Returns a map of noticeNum -> NSM billNumber for NsmLmSts-origin rows.
   * Used by proposalReason retry queue normalization to recover canonical
   * bill identifiers from persisted archive metadata.
   */
  async getNsmBillNumberByNoticeNums(
    noticeNums: number[],
  ): Promise<Map<number, string>> {
    const uniqueNums = Array.from(new Set(noticeNums));
    if (uniqueNums.length === 0) {
      return new Map();
    }

    const rows = await this.archiveRepository.find({
      where: { noticeNum: In(uniqueNums), contentId: IsNull() },
      select: { noticeNum: true, contentBillNumber: true },
    });

    const map = new Map<number, string>();
    for (const row of rows) {
      const billNumber = row.contentBillNumber?.trim();
      if (billNumber) {
        map.set(row.noticeNum, billNumber);
      }
    }

    return map;
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
   * Returns NSM-origin archived notices that still have empty proposalReason.
   * Used by proposalReason backfill cron to periodically re-seed retry queue
   * even when no newly discovered pending bills arrive.
   */
  async getNsmProposalReasonRetryCandidates(limit: number): Promise<
    Array<{
      notice: CachedNotice;
      billNo: string | null;
    }>
  > {
    const rows = await this.archiveRepository
      .createQueryBuilder('na')
      .select([
        'na.noticeNum AS noticeNum',
        'na.subject AS subject',
        'na.proposerCategory AS proposerCategory',
        'na.committee AS committee',
        'na.assemblyLink AS assemblyLink',
        'na.content_bill_number AS contentBillNumber',
        'na.attachmentPdfFile AS attachmentPdfFile',
        'na.attachmentHwpFile AS attachmentHwpFile',
      ])
      .where('na.contentId IS NULL')
      .andWhere('na.is_done = :isDone', { isDone: 0 })
      .andWhere('na.lifecycle_status = :status', { status: 'active' })
      .andWhere("(na.proposalReason IS NULL OR TRIM(na.proposalReason) = '')")
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM notice_change_events e
          INNER JOIN notice_change_details d ON d.event_id = e.id
          WHERE e.notice_num = na.noticeNum
            AND d.field_path = :proposalReasonFieldPath
            AND d.after_value IS NOT NULL
            AND TRIM(d.after_value) != ''
        )`,
        { proposalReasonFieldPath: 'proposalReason' },
      )
      .orderBy('na.noticeNum', 'ASC')
      .limit(limit)
      .getRawMany<{
        noticeNum: number;
        subject: string;
        proposerCategory: string;
        committee: string;
        assemblyLink: string;
        contentBillNumber: string | null;
        attachmentPdfFile: string | null;
        attachmentHwpFile: string | null;
      }>();

    return rows.map((row) => ({
      notice: {
        num: row.noticeNum,
        subject: row.subject,
        proposerCategory: row.proposerCategory,
        committee: row.committee,
        link: row.assemblyLink,
        contentId: null,
        proposalReason: null,
        attachments: {
          pdfFile: row.attachmentPdfFile ?? '',
          hwpFile: row.attachmentHwpFile ?? '',
        },
        aiSummary: null,
        aiSummaryStatus: 'not_supported',
      },
      billNo: row.contentBillNumber?.trim() || null,
    }));
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
    void items;
    return 0;
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
        proposalReason: true,
        attachmentPdfFile: true,
        attachmentHwpFile: true,
      },
      where: { isDone: false },
      order: { noticeNum: 'DESC' },
      take: limit,
    });

    if (this.summaryStateRepository && rows.length > 0) {
      const summaryStates = await this.getSummaryStateByNoticeNums(
        rows.map((row) => row.noticeNum),
      );

      for (const row of rows) {
        const summaryState = summaryStates.get(row.noticeNum);
        if (!summaryState) continue;
        row.aiSummary = summaryState.aiSummary;
        row.aiSummaryStatus = summaryState.aiSummaryStatus;
      }
    }

    return rows.map((row) =>
      mapArchiveEntityToCachedNotice(row, 'not_requested'),
    );
  }

  async getLatestProposalReasonForNotice(
    noticeNum: number,
  ): Promise<string | null> {
    if (!this.changeTrackingService) {
      return null;
    }

    try {
      return this.changeTrackingService.getLatestFieldAfterValue(
        noticeNum,
        'proposalReason',
      );
    } catch (error) {
      this.logger.warn(
        `Failed to load latest proposalReason from change chain for notice ${noticeNum}: ${(error as Error).message}`,
      );
      return null;
    }
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

    const rows = this.summaryStateRepository
      ? await this.summaryStateRepository.find({
          where: { noticeNum: In(uniqueNums) },
          select: {
            noticeNum: true,
            aiSummary: true,
            aiSummaryStatus: true,
          },
        })
      : await this.archiveRepository.find({
          where: {
            noticeNum: In(uniqueNums),
          },
          select: {
            noticeNum: true,
            aiSummary: true,
            aiSummaryStatus: true,
          },
        });

    return new Map<number, ArchiveSummaryState>(
      rows.map((row): [number, ArchiveSummaryState] => [
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
    const normalizedSummary = summary?.trim() ? summary : null;

    if (this.summaryStateRepository) {
      const updateResult = await this.summaryStateRepository.update(
        { noticeNum },
        {
          aiSummary: normalizedSummary,
          aiSummaryStatus: status,
        },
      );

      if ((updateResult.affected ?? 0) === 0) {
        try {
          await this.summaryStateRepository.insert({
            noticeNum,
            aiSummary: normalizedSummary,
            aiSummaryStatus: status,
          });
        } catch {
          // Another worker may have inserted the row concurrently.
          // Retry as UPDATE to converge state without relying on primary-key id.
          await this.summaryStateRepository.update(
            { noticeNum },
            {
              aiSummary: normalizedSummary,
              aiSummaryStatus: status,
            },
          );
        }
      }
      return;
    }

    await this.archiveRepository.update(
      { noticeNum },
      {
        aiSummary: normalizedSummary,
        aiSummaryStatus: status,
      },
    );
  }
}
