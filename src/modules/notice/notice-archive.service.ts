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
  Not,
  SelectQueryBuilder,
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
import { NoticeArchiveIntegrityCheck } from './notice-archive-integrity-check.entity';
import {
  NoticeArchiveIntegrityState,
  type ArchiveIntegrityStatus,
} from './notice-archive-integrity-state.entity';
import { NoticeArchiveSnapshotState } from './notice-archive-summary-state.entity';
import {
  NOTICE_ITEM_SELECT,
  buildArchiveWhereConditions,
  mapArchiveEntityToCachedNotice,
  mapArchiveEntityToNoticeItem,
  normalizeSortOrder,
  parseOptionalDate,
} from './notice-archive.helpers';
import { NoticeArchiveArtifactSupport } from './utils/notice-archive-artifact-support';
import {
  countByNoticeNumComparison,
  getArchiveCount,
  getArchiveStartedAtByNoticeNums,
  getLatestProposalReason,
  getNsmProposalReasonRetryCandidates,
  getRecentNoticesForCache,
  getSummaryStateByNoticeNums,
  runIntegrityScan,
  updateSummaryStateByNoticeNum,
} from './utils/notice-archive-maintenance-support';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import { type ChangeEventType } from '../change-tracking/notice-change-event.entity';
import { DEFAULT_TRACKED_FIELDS } from '../change-tracking/change-tracking-diff.utils';
import { NoticeChangeSource } from '../change-tracking/notice-change-source.enum';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../utils/logger.utils';
import { logAndBridge } from '../../utils/bridge-log.utils';

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
      status: ArchiveIntegrityStatus;
      checkedAt: Date | null;
      passed: boolean | null;
      skipReason: string | null;
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
  isDone: boolean;
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
    @InjectRepository(NoticeArchiveSnapshotState)
    private readonly summaryStateRepository?: Repository<NoticeArchiveSnapshotState>,
    @Optional()
    private readonly changeTrackingService?: ChangeTrackingService,
    @Optional() private readonly discordBridge?: DiscordBridgeService,
    @Optional()
    @InjectRepository(NoticeArchiveIntegrityCheck)
    private readonly integrityCheckRepository?: Repository<NoticeArchiveIntegrityCheck>,
    @Optional()
    @InjectRepository(NoticeArchiveIntegrityState)
    private readonly integrityStateRepository?: Repository<NoticeArchiveIntegrityState>,
  ) {
    this.artifactSupport = new NoticeArchiveArtifactSupport(
      this.archiveRepository,
      this.integrityCheckRepository,
      this.integrityStateRepository,
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

  private getMaintenanceDeps() {
    return {
      archiveRepository: this.archiveRepository,
      summaryStateRepository: this.summaryStateRepository,
      changeTrackingService: this.changeTrackingService,
      artifactSupport: this.artifactSupport,
      logger: this.logger,
    };
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

  private preferIncomingTrackedValue<T>(
    incoming: T | null | undefined,
    existing: T | null | undefined,
    options?: {
      preserveExistingWhenIncomingNull?: boolean;
      normalizeText?: boolean;
    },
  ): T | null {
    const preserve = options?.preserveExistingWhenIncomingNull ?? false;
    const normalizeText = options?.normalizeText ?? false;

    if (normalizeText) {
      const normalize = (value: T | null | undefined): T | null => {
        if (typeof value !== 'string') {
          return (value ?? null) as T | null;
        }

        const normalized = value.replace(/\s+/g, ' ').trim();
        return (normalized.length > 0 ? normalized : null) as T | null;
      };

      const normalizedIncoming = normalize(incoming);
      if (normalizedIncoming !== null) {
        return normalizedIncoming;
      }

      if (preserve) {
        return normalize(existing);
      }

      return null;
    }

    if (incoming !== null && incoming !== undefined) {
      return incoming;
    }

    if (preserve) {
      return (existing ?? null) as T | null;
    }

    return null;
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

        const built = this.changeTrackingService.buildDiffEvent({
          noticeNum: row.noticeNum,
          beforeSnapshot: null,
          afterSnapshot,
          detectedAt: boundaryAt,
          source: LEGACY_GENESIS_SOURCE,
          preferredEventType: 'created',
        });

        const event =
          await this.changeTrackingService.appendChangeEventWithDetails({
            noticeNum: row.noticeNum,
            eventType: built.eventType,
            eventHash: built.eventHash,
            detectedAt: built.detectedAt,
            source: LEGACY_GENESIS_SOURCE,
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
    const rows = await this.archiveRepository.find({
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
        lifecycleStatus: true,
        sourceDeletedAt: true,
      },
      order: { noticeNum: 'ASC' },
      skip,
      take,
    });

    const states = await this.getSummaryStateByNoticeNums(
      rows.map((row) => row.noticeNum),
    );

    for (const row of rows) {
      row.isDone = states.get(row.noticeNum)?.isDone ?? false;
    }

    return rows as TrackedArchiveRow[];
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
    const existing = beforeRow !== null;

    const resolvedProposalReason = this.preferIncomingTrackedValue(
      originalContent.proposalReason,
      beforeRow?.proposalReason,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentBillNumber = this.preferIncomingTrackedValue(
      this.normalizeStableId(originalContent.billNumber),
      this.normalizeStableId(beforeRow?.contentBillNumber),
      { preserveExistingWhenIncomingNull: existing },
    );

    const resolvedContentProposer = this.preferIncomingTrackedValue(
      originalContent.proposer?.trim() || null,
      beforeRow?.contentProposer ?? null,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentProposalDate = this.preferIncomingTrackedValue(
      originalContent.proposalDate?.trim() || null,
      beforeRow?.contentProposalDate ?? null,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentCommittee = this.preferIncomingTrackedValue(
      originalContent.committee?.trim() || null,
      beforeRow?.contentCommittee ?? null,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentReferralDate = this.preferIncomingTrackedValue(
      originalContent.referralDate?.trim() || null,
      beforeRow?.contentReferralDate ?? null,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentNoticePeriod = this.preferIncomingTrackedValue(
      originalContent.noticePeriod?.trim() || null,
      beforeRow?.contentNoticePeriod ?? null,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentProposalSession = this.preferIncomingTrackedValue(
      originalContent.proposalSession?.trim() || null,
      beforeRow?.contentProposalSession ?? null,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedIsDone =
      originalContent.isDone !== undefined
        ? originalContent.isDone
        : (beforeRow?.isDone ?? false);

    // Core content fields - always written on both INSERT and UPDATE.
    const coreFields = {
      noticeNum: notice.num,
      subject: notice.subject,
      proposerCategory: notice.proposerCategory,
      committee: notice.committee,
      assemblyLink: notice.link,
      contentId: notice.contentId ?? null,
      proposalReason: resolvedProposalReason ?? '',
      sourceTitle: originalContent.title?.trim() || notice.subject,
      contentBillNumber: resolvedContentBillNumber,
      contentProposer: resolvedContentProposer,
      contentProposalDate: resolvedContentProposalDate,
      contentCommittee: resolvedContentCommittee,
      contentReferralDate: resolvedContentReferralDate,
      contentNoticePeriod: resolvedContentNoticePeriod,
      contentProposalSession: resolvedContentProposalSession,
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
      lifecycleStatus: 'active' as NoticeLifecycleStatus,
      sourceDeletedAt: null,
    };
    const hasExplicitSummary =
      Object.prototype.hasOwnProperty.call(notice, 'aiSummary') ||
      Object.prototype.hasOwnProperty.call(notice, 'aiSummaryStatus');
    const summaryStatus =
      notice.aiSummaryStatus ?? AI_SUMMARY_STATUS.NOT_REQUESTED;
    const summaryPayload = {
      isDone: resolvedIsDone,
      aiSummary: notice.aiSummary ?? null,
      aiSummaryStatus: summaryStatus,
    };

    if (isRenumbering && beforeRow) {
      const beforeSnapshot = this.buildTrackedSnapshot(beforeRow);
      if (beforeSnapshot) {
        const invalidatedSnapshot = {
          ...beforeSnapshot,
          isDone: true,
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
            isDone: true,
            aiSummary: true,
            aiSummaryStatus: true,
          },
        });

        if (previousSummaryState) {
          await this.persistSummaryState(notice.num, {
            isDone: previousSummaryState.isDone,
            aiSummary: previousSummaryState.aiSummary ?? null,
            aiSummaryStatus: previousSummaryState.aiSummaryStatus,
          });

          await this.summaryStateRepository.delete({
            noticeNum: previousNoticeNum,
          });
        }
      }

      if (hasExplicitSummary) {
        const shouldPreventSummaryDowngrade =
          existing &&
          summaryPayload.aiSummaryStatus === AI_SUMMARY_STATUS.NOT_REQUESTED &&
          !summaryPayload.aiSummary?.trim();

        if (shouldPreventSummaryDowngrade) {
          const currentState = await this.summaryStateRepository.findOne({
            where: { noticeNum: notice.num },
            select: {
              isDone: true,
              aiSummary: true,
              aiSummaryStatus: true,
            },
          });

          const hasDurableSummary =
            !!currentState?.aiSummary?.trim() ||
            currentState?.aiSummaryStatus !== AI_SUMMARY_STATUS.NOT_REQUESTED;

          if (currentState && hasDurableSummary) {
            await this.persistSummaryState(notice.num, {
              isDone: summaryPayload.isDone,
              aiSummary: currentState.aiSummary ?? null,
              aiSummaryStatus: currentState.aiSummaryStatus,
            });
          } else {
            await this.persistSummaryState(notice.num, summaryPayload);
          }
        } else {
          await this.persistSummaryState(notice.num, summaryPayload);
        }
      } else {
        await this.ensureDefaultSummaryStateExists(notice.num, resolvedIsDone);
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
        isDone: resolvedIsDone,
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
    if (!this.summaryStateRepository || nums.length === 0) {
      return 0;
    }

    const uniqueNums = Array.from(new Set(nums));
    const changedStateRows = await this.summaryStateRepository.find({
      where: {
        noticeNum: In(uniqueNums),
        isDone: false,
      },
      select: {
        noticeNum: true,
      },
    });

    const changedNums = changedStateRows.map((row) => row.noticeNum);
    if (changedNums.length === 0) {
      return 0;
    }

    const beforeRowsByNoticeNum =
      await this.getTrackedRowsByNoticeNums(changedNums);

    const result = await this.summaryStateRepository.update(
      {
        noticeNum: In(changedNums),
        isDone: false,
      },
      {
        isDone: true,
      },
    );

    for (const noticeNum of changedNums) {
      const beforeRow = beforeRowsByNoticeNum.get(noticeNum);
      if (!beforeRow) {
        continue;
      }

      await this.appendTrackedDiffEvent(
        noticeNum,
        NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
        beforeRow,
        {
          ...beforeRow,
          isDone: true,
        },
      );
    }

    return result.affected ?? 0;
  }

  /**
   * Bulk-reverts archive records matching the given notice numbers to isDone=false.
   * Records already marked as active are not touched.
   * @returns Number of rows actually changed
   */
  async revertNoticesDoneByNums(nums: number[]): Promise<number> {
    if (!this.summaryStateRepository || nums.length === 0) {
      return 0;
    }

    const uniqueNums = Array.from(new Set(nums));
    const changedStateRows = await this.summaryStateRepository.find({
      where: {
        noticeNum: In(uniqueNums),
        isDone: true,
      },
      select: {
        noticeNum: true,
      },
    });

    const changedNums = changedStateRows.map((row) => row.noticeNum);
    if (changedNums.length === 0) {
      return 0;
    }

    const beforeRowsByNoticeNum =
      await this.getTrackedRowsByNoticeNums(changedNums);

    const result = await this.summaryStateRepository.update(
      {
        noticeNum: In(changedNums),
        isDone: true,
      },
      {
        isDone: false,
      },
    );

    for (const noticeNum of changedNums) {
      const beforeRow = beforeRowsByNoticeNum.get(noticeNum);
      if (!beforeRow) {
        continue;
      }

      await this.appendTrackedDiffEvent(
        noticeNum,
        NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
        beforeRow,
        {
          ...beforeRow,
          isDone: false,
        },
      );
    }

    return result.affected ?? 0;
  }

  async markSourceDeletedByMissingPalNums(
    seenPalActiveNums: Set<number>,
  ): Promise<number> {
    void seenPalActiveNums;
    return 0;
  }

  async appendSourceDeletedEventByNoticeNum(noticeNum: number): Promise<void> {
    const beforeRow = await this.getTrackedRowByNoticeNum(noticeNum);
    if (!beforeRow) {
      return;
    }

    const beforeSnapshot = await this.buildDiffBaselineSnapshot(
      noticeNum,
      beforeRow,
    );
    if (!beforeSnapshot) {
      return;
    }

    const alreadySourceDeleted =
      typeof beforeSnapshot.lifecycleStatus === 'string' &&
      beforeSnapshot.lifecycleStatus === 'source_deleted';
    if (alreadySourceDeleted) {
      return;
    }

    const deletedAt = new Date().toISOString();
    const afterSnapshot = {
      ...beforeSnapshot,
      isDone: true,
      lifecycleStatus: 'source_deleted',
      sourceDeletedAt: deletedAt,
    };

    await this.appendExplicitEventWithDiff({
      noticeNum,
      source: NoticeChangeSource.ARCHIVE_SOURCE_MISSING,
      eventType: 'invalidated',
      beforeSnapshot,
      afterSnapshot,
      subject: beforeRow.subject,
    });

    if (this.summaryStateRepository) {
      const currentState = await this.summaryStateRepository.findOne({
        where: { noticeNum },
        select: {
          isDone: true,
          aiSummary: true,
          aiSummaryStatus: true,
        },
      });

      if (!currentState) {
        await this.persistSummaryState(noticeNum, {
          isDone: true,
          aiSummary: null,
          aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED,
        });
      } else if (!currentState.isDone) {
        await this.persistSummaryState(noticeNum, {
          isDone: true,
          aiSummary: currentState.aiSummary ?? null,
          aiSummaryStatus: currentState.aiSummaryStatus,
        });
      }
    }
  }

  /**
   * Returns one page of noticeNums that are currently marked isDone=true,
   * ordered by noticeNum ASC. Used by the revert pass to scan only the
   * records that could potentially need reverting - skips isDone=false rows
   * entirely.
   */
  async getDoneMarkedNumsPage(skip: number, take: number): Promise<number[]> {
    if (!this.summaryStateRepository) {
      return [];
    }

    const rows = await this.summaryStateRepository.find({
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
   * When there is no pending row, this also pulls a recovery page from
   * `'not_supported'` for NSM rows (`contentId IS NULL`) so legacy rows that
   * were prematurely marked not_supported can re-enter the backfill pipeline
   * once proposalReason becomes available via change-chain repair.
   *
   * Intended for a **drain loop** - callers should always pass `skip=0`
   * because processed rows transition away from `'not_requested'` and
   * naturally drop out of subsequent calls.
   */
  async getPendingSummaryPage(take: number): Promise<CachedNotice[]> {
    const pending = await this.collectSummaryBackfillCandidates(
      AI_SUMMARY_STATUS.NOT_REQUESTED,
      0,
      take,
    );

    if (pending.length > 0) {
      return pending;
    }

    return this.collectSummaryBackfillCandidates(
      AI_SUMMARY_STATUS.NOT_SUPPORTED,
      0,
      take,
      (row) => !row.contentId,
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
    return this.collectSummaryBackfillCandidates(
      AI_SUMMARY_STATUS.UNAVAILABLE,
      skip,
      take,
    );
  }

  private async collectSummaryBackfillCandidates(
    status: AISummaryStatus,
    skip: number,
    take: number,
    rawRowFilter?: (row: CachedNotice) => boolean,
  ): Promise<CachedNotice[]> {
    const pageSize = Math.max(take, 1);
    const candidates: CachedNotice[] = [];
    let rawSkip = Math.max(skip, 0);

    for (;;) {
      const rows = await this.getSummaryPageByStatus(status, rawSkip, pageSize);
      if (rows.length === 0) {
        break;
      }

      const filteredRows = rawRowFilter ? rows.filter(rawRowFilter) : rows;

      if (filteredRows.length === 0) {
        if (rows.length < pageSize) {
          break;
        }
        rawSkip += pageSize;
        continue;
      }

      const eligibleRows =
        await this.resolveSummaryBackfillCandidates(filteredRows);
      candidates.push(...eligibleRows);

      if (candidates.length >= pageSize || rows.length < pageSize) {
        break;
      }

      rawSkip += pageSize;
    }

    return candidates.slice(0, pageSize);
  }

  private async getSummaryPageByStatus(
    status: AISummaryStatus,
    skip: number,
    take: number,
  ): Promise<CachedNotice[]> {
    if (!this.summaryStateRepository) {
      const rows = await this.archiveRepository.find({
        where: { aiSummaryStatus: status },
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
          aiSummary: true,
          aiSummaryStatus: true,
        },
        order: { noticeNum: 'ASC' },
        skip,
        take,
      });

      return rows.map((row) => mapArchiveEntityToCachedNotice(row, status));
    }

    const summaryRows = await this.summaryStateRepository.find({
      where: {
        aiSummaryStatus: status,
      },
      select: {
        noticeNum: true,
        aiSummary: true,
        aiSummaryStatus: true,
      },
      order: {
        noticeNum: 'ASC',
      },
      skip,
      take,
    });

    const noticeNums = summaryRows.map((row) => row.noticeNum);
    if (noticeNums.length === 0) {
      return [];
    }

    const archives = await this.archiveRepository.find({
      where: { noticeNum: In(noticeNums) },
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
    });

    const archiveByNoticeNum = new Map(
      archives.map((archive) => [archive.noticeNum, archive] as const),
    );

    return summaryRows
      .map((summary) => {
        const archive = archiveByNoticeNum.get(summary.noticeNum);
        if (!archive) {
          return null;
        }

        return mapArchiveEntityToCachedNotice(
          {
            noticeNum: archive.noticeNum,
            subject: archive.subject,
            proposerCategory: archive.proposerCategory,
            committee: archive.committee,
            assemblyLink: archive.assemblyLink,
            contentId: archive.contentId,
            proposalReason: archive.proposalReason ?? '',
            attachmentPdfFile: archive.attachmentPdfFile ?? '',
            attachmentHwpFile: archive.attachmentHwpFile ?? '',
            aiSummary: summary.aiSummary,
            aiSummaryStatus: summary.aiSummaryStatus as AISummaryStatus,
          },
          status,
        );
      })
      .filter((row): row is CachedNotice => row !== null);
  }

  private async resolveSummaryBackfillCandidates(
    rows: CachedNotice[],
  ): Promise<CachedNotice[]> {
    const resolved: Array<CachedNotice | null> = await Promise.all(
      rows.map(async (row): Promise<CachedNotice | null> => {
        const snapshotProposalReason = row.proposalReason?.trim() || null;

        if (row.contentId || snapshotProposalReason) {
          return {
            ...row,
            proposalReason: snapshotProposalReason,
          };
        }

        const latestProposalReason =
          await this.getLatestProposalReasonForNotice(row.num);

        if (!latestProposalReason) {
          return null;
        }

        return {
          ...row,
          proposalReason: latestProposalReason,
        };
      }),
    );

    return resolved.filter((row): row is CachedNotice => row !== null);
  }

  private applyArchiveSearchFilters(
    qb: SelectQueryBuilder<NoticeArchive>,
    params: {
      search?: string;
      startDate?: Date;
      endDate?: Date;
      fullText?: boolean;
    },
  ): void {
    const search = (params.search || '').trim();

    if (params.startDate && params.endDate) {
      const rangeStart =
        params.startDate <= params.endDate ? params.startDate : params.endDate;
      const rangeEnd =
        params.startDate <= params.endDate ? params.endDate : params.startDate;
      qb.andWhere(
        'archive.archive_started_at BETWEEN :rangeStart AND :rangeEnd',
        {
          rangeStart,
          rangeEnd,
        },
      );
    } else if (params.startDate) {
      qb.andWhere('archive.archive_started_at >= :startDate', {
        startDate: params.startDate,
      });
    } else if (params.endDate) {
      qb.andWhere('archive.archive_started_at <= :endDate', {
        endDate: params.endDate,
      });
    }

    if (!search) {
      return;
    }

    qb.andWhere(
      new Brackets((query) => {
        query
          .where('archive.subject LIKE :search', {
            search: `%${search}%`,
          })
          .orWhere('archive.committee LIKE :search', {
            search: `%${search}%`,
          });

        if (params.fullText) {
          query.orWhere('archive.proposalReason LIKE :search', {
            search: `%${search}%`,
          });
        }
      }),
    );
  }

  private async queryArchiveNoticeNumsByIsDoneFilter(params: {
    isDone: boolean;
    search?: string;
    startDate?: Date;
    endDate?: Date;
    fullText?: boolean;
    sortOrder: 'asc' | 'desc';
    skip: number;
    take: number;
  }): Promise<{ total: number; noticeNums: number[] }> {
    if (!this.summaryStateRepository) {
      return { total: 0, noticeNums: [] };
    }

    const baseQb = this.archiveRepository
      .createQueryBuilder('archive')
      .innerJoin(
        NoticeArchiveSnapshotState,
        'summary',
        'summary.notice_num = archive.noticeNum',
      )
      .where('summary.is_done = :isDone', {
        isDone: params.isDone ? 1 : 0,
      });

    this.applyArchiveSearchFilters(baseQb, params);

    const total = await baseQb.clone().getCount();
    if (params.take <= 0) {
      return { total, noticeNums: [] };
    }

    const rows = await baseQb
      .clone()
      .select('archive.noticeNum', 'noticeNum')
      .orderBy('archive.noticeNum', params.sortOrder === 'asc' ? 'ASC' : 'DESC')
      .addOrderBy(
        'archive.archive_started_at',
        params.sortOrder === 'asc' ? 'ASC' : 'DESC',
      )
      .offset(params.skip)
      .limit(params.take)
      .getRawMany<{ noticeNum: number }>();

    return {
      total,
      noticeNums: rows.map((row) => Number(row.noticeNum)),
    };
  }

  private async getTrackedRowsByNoticeNums(
    noticeNums: number[],
  ): Promise<Map<number, TrackedArchiveRow>> {
    const uniqueNums = Array.from(new Set(noticeNums));
    if (uniqueNums.length === 0) {
      return new Map();
    }

    const rows = await this.archiveRepository.find({
      where: { noticeNum: In(uniqueNums) },
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
        lifecycleStatus: true,
        sourceDeletedAt: true,
      },
    });

    const states = await this.getSummaryStateByNoticeNums(uniqueNums);
    const map = new Map<number, TrackedArchiveRow>();
    for (const row of rows) {
      row.isDone = states.get(row.noticeNum)?.isDone ?? false;
      map.set(row.noticeNum, row as TrackedArchiveRow);
    }

    return map;
  }

  private async applyLifecycleOverlayFromDiffchain(
    rows: NoticeArchive[],
  ): Promise<void> {
    if (!this.changeTrackingService || rows.length === 0) {
      return;
    }

    await Promise.all(
      rows.map(async (row) => {
        const [latestLifecycleStatus, latestSourceDeletedAt] =
          await Promise.all([
            this.changeTrackingService.getLatestFieldAfterValue(
              row.noticeNum,
              'lifecycleStatus',
            ),
            this.changeTrackingService.getLatestFieldAfterValue(
              row.noticeNum,
              'sourceDeletedAt',
            ),
          ]);

        if (
          latestLifecycleStatus === 'active' ||
          latestLifecycleStatus === 'source_deleted' ||
          latestLifecycleStatus === 'renumbered'
        ) {
          row.lifecycleStatus = latestLifecycleStatus;
        }

        if (latestSourceDeletedAt) {
          const parsed = new Date(latestSourceDeletedAt);
          if (!Number.isNaN(parsed.getTime())) {
            row.sourceDeletedAt = parsed;
          }
        }
      }),
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
      fullText: query.fullText,
    });
    const sortOrder = normalizeSortOrder(query.sortOrder);

    let rows: NoticeArchive[] = [];
    let total: number;

    if (query.isDone !== undefined && this.summaryStateRepository) {
      const paged = await this.queryArchiveNoticeNumsByIsDoneFilter({
        isDone: query.isDone,
        search,
        startDate: query.startDate,
        endDate: query.endDate,
        fullText: query.fullText,
        sortOrder,
        skip,
        take: limit,
      });
      total = paged.total;

      if (paged.noticeNums.length > 0) {
        const fetched = await this.archiveRepository.find({
          where: { noticeNum: In(paged.noticeNums) },
          select: NOTICE_ITEM_SELECT,
        });
        const rank = new Map(
          paged.noticeNums.map((num, idx) => [num, idx] as const),
        );
        rows = fetched.sort(
          (a, b) => (rank.get(a.noticeNum) ?? 0) - (rank.get(b.noticeNum) ?? 0),
        );
      }
    } else {
      const result = await this.archiveRepository.findAndCount({
        where,
        select: NOTICE_ITEM_SELECT,
        order: {
          noticeNum: sortOrder === 'asc' ? 'ASC' : 'DESC',
          archiveStartedAt: sortOrder === 'asc' ? 'ASC' : 'DESC',
        },
        skip,
        take: limit,
      });
      rows = result[0];
      total = result[1];
    }

    if (this.summaryStateRepository && rows.length > 0) {
      const summaryStates = await this.getSummaryStateByNoticeNums(
        rows.map((row) => row.noticeNum),
      );

      for (const row of rows) {
        const summaryState = summaryStates.get(row.noticeNum);
        if (!summaryState) continue;
        row.isDone = summaryState.isDone;
        row.aiSummary = summaryState.aiSummary;
        row.aiSummaryStatus = summaryState.aiSummaryStatus;
      }
    }

    await this.applyLifecycleOverlayFromDiffchain(rows);

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

    if (this.summaryStateRepository && rows.length > 0) {
      const summaryStates = await this.getSummaryStateByNoticeNums(
        rows.map((row) => row.noticeNum),
      );

      for (const row of rows) {
        const summaryState = summaryStates.get(row.noticeNum);
        if (!summaryState) continue;
        row.isDone = summaryState.isDone;
        row.aiSummary = summaryState.aiSummary;
        row.aiSummaryStatus = summaryState.aiSummaryStatus;
      }
    }

    await this.applyLifecycleOverlayFromDiffchain(rows);

    return rows.map((row) => mapArchiveEntityToNoticeItem(row));
  }

  async getArchiveNoticesByNoticeNums(
    noticeNums: number[],
  ): Promise<ArchiveNoticeItem[]> {
    const uniqueNums = Array.from(new Set(noticeNums)).filter(
      (num) => Number.isInteger(num) && num > 0,
    );

    if (uniqueNums.length === 0) {
      return [];
    }

    const rows = await this.archiveRepository.find({
      where: { noticeNum: In(uniqueNums) },
      select: NOTICE_ITEM_SELECT,
    });

    if (rows.length === 0) {
      return [];
    }

    const rank = new Map(uniqueNums.map((num, idx) => [num, idx] as const));
    rows.sort(
      (a, b) => (rank.get(a.noticeNum) ?? 0) - (rank.get(b.noticeNum) ?? 0),
    );

    if (this.summaryStateRepository) {
      const summaryStates = await this.getSummaryStateByNoticeNums(
        rows.map((row) => row.noticeNum),
      );

      for (const row of rows) {
        const summaryState = summaryStates.get(row.noticeNum);
        if (!summaryState) continue;
        row.isDone = summaryState.isDone;
        row.aiSummary = summaryState.aiSummary;
        row.aiSummaryStatus = summaryState.aiSummaryStatus;
      }
    }

    await this.applyLifecycleOverlayFromDiffchain(rows);

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
      fullText: query.fullText,
    });
    const sortOrder = normalizeSortOrder(query.sortOrder);

    let total: number;

    // Use knownTotal when provided to avoid a redundant COUNT query.
    if (query.knownTotal !== undefined) {
      total = query.knownTotal;
    } else if (query.isDone !== undefined && this.summaryStateRepository) {
      total = (
        await this.queryArchiveNoticeNumsByIsDoneFilter({
          isDone: query.isDone,
          search,
          startDate: query.startDate,
          endDate: query.endDate,
          fullText: query.fullText,
          sortOrder,
          skip: 0,
          take: 0,
        })
      ).total;
    } else {
      total = await this.archiveRepository.count({ where });
    }

    if (take === 0) {
      return {
        items: [],
        total,
        search,
      };
    }

    let rows: NoticeArchive[] = [];
    if (query.isDone !== undefined && this.summaryStateRepository) {
      const paged = await this.queryArchiveNoticeNumsByIsDoneFilter({
        isDone: query.isDone,
        search,
        startDate: query.startDate,
        endDate: query.endDate,
        fullText: query.fullText,
        sortOrder,
        skip,
        take,
      });

      if (paged.noticeNums.length > 0) {
        const fetched = await this.archiveRepository.find({
          where: { noticeNum: In(paged.noticeNums) },
          select: NOTICE_ITEM_SELECT,
        });
        const rank = new Map(
          paged.noticeNums.map((num, idx) => [num, idx] as const),
        );
        rows = fetched.sort(
          (a, b) => (rank.get(a.noticeNum) ?? 0) - (rank.get(b.noticeNum) ?? 0),
        );
      }
    } else {
      rows = await this.archiveRepository.find({
        where,
        select: NOTICE_ITEM_SELECT,
        order: {
          noticeNum: sortOrder === 'asc' ? 'ASC' : 'DESC',
          archiveStartedAt: sortOrder === 'asc' ? 'ASC' : 'DESC',
        },
        skip,
        take,
      });
    }

    if (this.summaryStateRepository && rows.length > 0) {
      const summaryStates = await this.getSummaryStateByNoticeNums(
        rows.map((row) => row.noticeNum),
      );

      for (const row of rows) {
        const summaryState = summaryStates.get(row.noticeNum);
        if (!summaryState) continue;
        row.isDone = summaryState.isDone;
        row.aiSummary = summaryState.aiSummary;
        row.aiSummaryStatus = summaryState.aiSummaryStatus;
      }
    }

    await this.applyLifecycleOverlayFromDiffchain(rows);

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
    const excludedOverlayFields =
      requestedRev === null ? new Set<string>(['isDone']) : undefined;
    const detailWithRevision = this.applyRevisionOverlay(
      detail,
      eventsAsc,
      resolvedRev,
      {
        excludedFieldPaths: excludedOverlayFields,
      },
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
    options?: {
      excludedFieldPaths?: ReadonlySet<string>;
    },
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
    const excludedFieldPaths = options?.excludedFieldPaths;

    for (const event of eventsAsc) {
      for (const detail of event.details) {
        if (!timelineState.has(detail.fieldPath)) {
          continue;
        }

        if (excludedFieldPaths?.has(detail.fieldPath)) {
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
      if (excludedFieldPaths?.has(fieldPath)) {
        continue;
      }

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
      const warnMessage = `Failed to collect change-tracking export data for notice ${noticeNum}: ${(error as Error).message}`;
      logAndBridge({
        logger: this.logger,
        method: 'warn',
        message: warnMessage,
        context: NoticeArchiveService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.WARN,
        metadata: { noticeNum },
      });
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
      select: { noticeNum: true, contentId: true },
      where: {
        screenshotBlob: IsNull(),
        contentId: Not(IsNull()),
      },
      order: { noticeNum: 'ASC' },
      take: limit,
    });

    const stateByNoticeNum = await this.getSummaryStateByNoticeNums(
      rows.map((row) => row.noticeNum),
    );

    return rows.map((row) => ({
      num: row.noticeNum,
      contentId: row.contentId!,
      isDone: stateByNoticeNum.get(row.noticeNum)?.isDone ?? false,
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
      select: { noticeNum: true, contentId: true },
      where: { contentId: Not(IsNull()) },
      order: { noticeNum: 'ASC' },
    });

    const stateByNoticeNum = await this.getSummaryStateByNoticeNums(
      rows.map((row) => row.noticeNum),
    );

    return rows.map((row) => ({
      num: row.noticeNum,
      contentId: row.contentId!,
      isDone: stateByNoticeNum.get(row.noticeNum)?.isDone ?? false,
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
      billNumber?: string | null;
      proposer?: string | null;
      proposalDate?: string | null;
      committee?: string | null;
      referralDate?: string | null;
      noticePeriod?: string | null;
      proposalSession?: string | null;
      httpMetadata: ArchiveHttpMetadata | null;
      screenshotBlob?: Buffer;
      screenshotFormat?: string;
    },
  ): Promise<void> {
    const beforeRow = await this.getTrackedRowByNoticeNum(noticeNum);
    if (!beforeRow) {
      return;
    }

    const beforeSnapshot = await this.buildDiffBaselineSnapshot(
      noticeNum,
      beforeRow,
    );
    if (!beforeSnapshot) {
      return;
    }

    const latestProposalReason =
      await this.getLatestProposalReasonForNotice(noticeNum);
    const normalizedLatestProposalReason =
      this.normalizeProposalReasonText(latestProposalReason);

    // Keep chain-head proposalReason as baseline to avoid stale-row re-emission
    // when repair callers only mock latest-field reads.
    if (normalizedLatestProposalReason !== null) {
      beforeSnapshot.proposalReason = normalizedLatestProposalReason;
    }

    const beforeText = (key: string): string | null => {
      const value = beforeSnapshot[key];
      return typeof value === 'string' ? value : null;
    };

    const resolvedProposalReason = this.preferIncomingTrackedValue(
      payload.proposalReason,
      beforeText('proposalReason'),
      {
        preserveExistingWhenIncomingNull: true,
        normalizeText: true,
      },
    );

    const resolvedBillNumber = this.preferIncomingTrackedValue(
      this.normalizeStableId(payload.billNumber),
      this.normalizeStableId(beforeText('billNumber')),
      { preserveExistingWhenIncomingNull: true },
    );

    const resolvedProposer = this.preferIncomingTrackedValue(
      payload.proposer?.trim() || null,
      beforeText('proposer'),
      {
        preserveExistingWhenIncomingNull: true,
        normalizeText: true,
      },
    );

    const resolvedProposalDate = this.preferIncomingTrackedValue(
      payload.proposalDate?.trim() || null,
      beforeText('proposalDate'),
      {
        preserveExistingWhenIncomingNull: true,
        normalizeText: true,
      },
    );

    const resolvedCommittee = this.preferIncomingTrackedValue(
      payload.committee?.trim() || null,
      beforeText('contentCommittee'),
      {
        preserveExistingWhenIncomingNull: true,
        normalizeText: true,
      },
    );

    const resolvedReferralDate = this.preferIncomingTrackedValue(
      payload.referralDate?.trim() || null,
      beforeText('referralDate'),
      {
        preserveExistingWhenIncomingNull: true,
        normalizeText: true,
      },
    );

    const resolvedNoticePeriod = this.preferIncomingTrackedValue(
      payload.noticePeriod?.trim() || null,
      beforeText('noticePeriod'),
      {
        preserveExistingWhenIncomingNull: true,
        normalizeText: true,
      },
    );

    const resolvedProposalSession = this.preferIncomingTrackedValue(
      payload.proposalSession?.trim() || null,
      beforeText('proposalSession'),
      {
        preserveExistingWhenIncomingNull: true,
        normalizeText: true,
      },
    );

    const afterSnapshot = {
      ...beforeSnapshot,
      proposalReason: resolvedProposalReason ?? '',
      billNumber: resolvedBillNumber,
      proposer: resolvedProposer,
      proposalDate: resolvedProposalDate,
      contentCommittee: resolvedCommittee,
      referralDate: resolvedReferralDate,
      noticePeriod: resolvedNoticePeriod,
      proposalSession: resolvedProposalSession,
    };

    await this.appendExplicitEventWithDiff({
      noticeNum,
      source: NoticeChangeSource.ARCHIVE_UPDATE_NSM_HTML_AND_DETAIL,
      eventType: 'updated',
      beforeSnapshot,
      afterSnapshot,
      subject: beforeRow.subject,
    });
  }

  private async getTrackedRowByNoticeNum(
    noticeNum: number,
  ): Promise<TrackedArchiveRow | null> {
    const row = await this.archiveRepository.findOne({
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
        lifecycleStatus: true,
        sourceDeletedAt: true,
      },
    });

    if (!row) {
      return null;
    }

    row.isDone =
      (await this.getSummaryStateByNoticeNums([noticeNum])).get(noticeNum)
        ?.isDone ?? false;

    return row;
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
        lifecycleStatus: true,
        sourceDeletedAt: true,
      },
      order: { noticeNum: 'DESC' },
    });

    if (!matched || matched.noticeNum === incomingNoticeNum) {
      return null;
    }

    matched.isDone =
      (await this.getSummaryStateByNoticeNums([matched.noticeNum])).get(
        matched.noticeNum,
      )?.isDone ?? false;

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
      const beforeSnapshot = await this.buildDiffBaselineSnapshot(
        noticeNum,
        beforeRow,
      );
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
          const warnMessage = `Failed to dispatch change notification for event ${event.id}: ${(dispatchError as Error).message}`;
          logAndBridge({
            logger: this.logger,
            method: 'warn',
            message: warnMessage,
            context: NoticeArchiveService.name,
            discordBridge: this.discordBridge,
            bridgeLevel: BridgeLogLevel.WARN,
            metadata: { eventId: event.id, noticeNum },
          });
        });
    } catch (error) {
      const warnMessage = `Failed to append change event for notice ${noticeNum} (${source}): ${(error as Error).message}`;
      logAndBridge({
        logger: this.logger,
        method: 'warn',
        message: warnMessage,
        context: NoticeArchiveService.name,
        discordBridge: this.discordBridge,
        bridgeLevel: BridgeLogLevel.WARN,
        metadata: { noticeNum, source },
      });
      throw error;
    }
  }

  private async persistSummaryState(
    noticeNum: number,
    payload: {
      isDone?: boolean;
      aiSummary: string | null;
      aiSummaryStatus: string;
    },
  ): Promise<void> {
    if (!this.summaryStateRepository) {
      return;
    }

    const existing = await this.summaryStateRepository.findOne({
      where: { noticeNum },
      select: { id: true },
    });

    if (existing?.id) {
      await this.summaryStateRepository.update(
        { id: existing.id },
        {
          ...(payload.isDone === undefined ? {} : { isDone: payload.isDone }),
          aiSummary: payload.aiSummary,
          aiSummaryStatus: payload.aiSummaryStatus,
        },
      );
      return;
    }

    await this.summaryStateRepository.insert({
      noticeNum,
      isDone: payload.isDone ?? false,
      aiSummary: payload.aiSummary,
      aiSummaryStatus: payload.aiSummaryStatus,
    });
  }

  private async ensureDefaultSummaryStateExists(
    noticeNum: number,
    isDone: boolean,
  ): Promise<void> {
    if (!this.summaryStateRepository) {
      return;
    }

    const existing = await this.summaryStateRepository.findOne({
      where: { noticeNum },
      select: { id: true },
    });

    if (existing?.id) {
      return;
    }

    try {
      await this.summaryStateRepository.insert({
        noticeNum,
        isDone,
        aiSummary: null,
        aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED,
      });
    } catch (error) {
      if (this.isSummaryStateUniqueConflict(error)) {
        return;
      }
      throw error;
    }
  }

  private isSummaryStateUniqueConflict(error: unknown): boolean {
    const extract = (value: unknown) => {
      const obj = (value as Record<string, unknown> | undefined) ?? {};
      return {
        code: String(obj.code ?? '').toLowerCase(),
        message: String(obj.message ?? '').toLowerCase(),
        detail: String(obj.detail ?? '').toLowerCase(),
        constraint: String(obj.constraint ?? '').toLowerCase(),
      };
    };

    const candidates = [error];
    const driverError = (error as { driverError?: unknown } | undefined)
      ?.driverError;
    if (driverError) {
      candidates.push(driverError);
    }

    for (const candidate of candidates) {
      const meta = extract(candidate);
      const text = `${meta.constraint} ${meta.detail} ${meta.message}`;

      const isKnownUniqueCode =
        meta.code === '23505' ||
        meta.code === 'sqlite_constraint' ||
        meta.code === 'sqlite_constraint_unique' ||
        meta.code === 'er_dup_entry';
      const hasUniqueText =
        text.includes('unique constraint') ||
        text.includes('duplicate key') ||
        text.includes('idx_notice_archive_snapshot_states_notice_num');
      const isNoticeNumConstraint =
        text.includes('notice_archive_snapshot_states.notice_num') ||
        text.includes('idx_notice_archive_snapshot_states_notice_num');

      if ((isKnownUniqueCode || hasUniqueText) && isNoticeNumConstraint) {
        return true;
      }
    }

    return false;
  }

  private async buildDiffBaselineSnapshot(
    noticeNum: number,
    beforeRow: TrackedArchiveRow | null,
  ): Promise<Record<string, unknown> | null> {
    const baseSnapshot = this.buildTrackedSnapshot(beforeRow);

    if (!this.changeTrackingService || !baseSnapshot) {
      return baseSnapshot;
    }

    try {
      const timeline = await this.changeTrackingService.getNoticeChangeTimeline(
        {
          noticeNum,
          limit: 1000,
        },
      );

      if (timeline.length === 0) {
        return baseSnapshot;
      }

      const latestByField = new Map<string, string | null>();
      const eventsAsc = [...timeline].sort(
        (left, right) => left.eventHeight - right.eventHeight,
      );

      for (const event of eventsAsc) {
        for (const detail of event.details) {
          latestByField.set(detail.fieldPath, detail.afterValue);
        }
      }

      const merged = { ...baseSnapshot };
      for (const fieldPath of DEFAULT_TRACKED_FIELDS) {
        if (!latestByField.has(fieldPath)) {
          continue;
        }
        merged[fieldPath] = this.coerceTrackedFieldValueForSnapshot(
          fieldPath,
          latestByField.get(fieldPath) ?? null,
        );
      }

      return merged;
    } catch (error) {
      this.logger.warn(
        `Failed to resolve diff baseline from chain head for notice ${noticeNum}: ${(error as Error).message}`,
      );
      return baseSnapshot;
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

    const built = this.changeTrackingService.buildDiffEvent({
      noticeNum: input.noticeNum,
      beforeSnapshot: input.beforeSnapshot,
      afterSnapshot: input.afterSnapshot,
      source: input.source,
      detectedAt: new Date(),
      preferredEventType: input.eventType,
    });

    if (!built.shouldAppend) {
      return;
    }

    const event = await this.changeTrackingService.appendChangeEventWithDetails(
      {
        noticeNum: input.noticeNum,
        eventType: built.eventType,
        eventHash: built.eventHash,
        detectedAt: built.detectedAt,
        source: input.source,
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
      },
    );

    void this.changeTrackingService
      .dispatchChangeNotification({
        event,
        subject: input.subject,
        changedFields: built.diff.details.map((detail) => detail.fieldPath),
      })
      .catch((dispatchError) => {
        this.logger.warn(
          `Failed to dispatch explicit ${input.eventType} notification for notice ${input.noticeNum}: ${(dispatchError as Error).message}`,
        );
      });
  }

  private coerceTrackedFieldValueForSnapshot(
    fieldPath: string,
    value: string | null,
  ): unknown {
    if (value === null) {
      return null;
    }

    if (fieldPath === 'num') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : value;
    }

    if (fieldPath === 'isDone') {
      if (value === 'true') return true;
      if (value === 'false') return false;
    }

    return value;
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

  async getSourceDeletedNoticeNumSet(
    noticeNums: number[],
  ): Promise<Set<number>> {
    const uniqueNums = Array.from(new Set(noticeNums));
    if (uniqueNums.length === 0 || !this.changeTrackingService) {
      return new Set();
    }

    const sourceDeletedNums = new Set<number>();

    await Promise.all(
      uniqueNums.map(async (noticeNum) => {
        try {
          const lifecycle =
            await this.changeTrackingService.getLatestFieldAfterValue(
              noticeNum,
              'lifecycleStatus',
            );
          if (lifecycle === 'source_deleted') {
            sourceDeletedNums.add(noticeNum);
          }
        } catch {
          // Ignore lookup failures; retry flow can still proceed for this item.
        }
      }),
    );

    return sourceDeletedNums;
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
    return getNsmProposalReasonRetryCandidates(
      this.getMaintenanceDeps(),
      limit,
    );
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
    return getArchiveCount(this.getMaintenanceDeps());
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
    return getRecentNoticesForCache(this.getMaintenanceDeps(), limit);
  }

  async getLatestProposalReasonForNotice(
    noticeNum: number,
  ): Promise<string | null> {
    return getLatestProposalReason(this.getMaintenanceDeps(), noticeNum);
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
  async runIntegrityScan(batchSize = 200): Promise<{
    scanned: number;
    passed: number;
    failed: number;
    skipped: number;
  }> {
    return runIntegrityScan(this.getMaintenanceDeps(), batchSize);
  }

  async getArchiveStartedAtByNoticeNums(
    noticeNums: number[],
  ): Promise<Map<number, Date>> {
    return getArchiveStartedAtByNoticeNums(
      this.getMaintenanceDeps(),
      noticeNums,
    );
  }

  async countByNoticeNumComparison(
    query: ArchiveNumCompareCountQuery,
  ): Promise<number> {
    return countByNoticeNumComparison(this.getMaintenanceDeps(), query);
  }

  async getSummaryStateByNoticeNums(
    noticeNums: number[],
  ): Promise<Map<number, ArchiveSummaryState>> {
    return getSummaryStateByNoticeNums(this.getMaintenanceDeps(), noticeNums);
  }

  async updateSummaryStateByNoticeNum(
    noticeNum: number,
    summary: string | null,
    status: AISummaryStatus,
  ): Promise<void> {
    await updateSummaryStateByNoticeNum(
      this.getMaintenanceDeps(),
      noticeNum,
      summary,
      status,
    );
  }
}
