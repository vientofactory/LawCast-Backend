import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  Not,
  Or,
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
import { APP_CONSTANTS } from '../../config/app.config';
import { type NsmDeletionProbeOutcome } from '../crawling/crawling-core.service';
import {
  NoticeArchive,
  NOTICE_LIFECYCLE_STATUS,
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
  computeSha256,
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
  getProposalReasonRetryCandidates,
  getRecentNoticesForCache,
  getSummaryStateByNoticeNums,
  recordProposalReasonAttempts,
  runIntegrityScan,
  updateSummaryStateByNoticeNum,
  updateSummaryStatesByNoticeNums,
  type SummaryStateBulkUpdateInput,
  type SummaryStateWriteStats,
} from './utils/notice-archive-maintenance-support';
import { ChangeTrackingService } from '../change-tracking/change-tracking.service';
import {
  CHANGE_EVENT_TYPE,
  type ChangeEventType,
} from '../change-tracking/notice-change-event.entity';
import {
  DEFAULT_TRACKED_FIELDS,
  canonicalizeChangeSnapshotForSource,
} from '../change-tracking/change-tracking-diff.utils';
import { NoticeChangeSource } from '../change-tracking/notice-change-source.enum';
import { DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { LoggerUtils } from '../../utils/logger.utils';
import { logAndBridge } from '../../utils/bridge-log.utils';
import {
  describeNsmDeletionDetectionDisabled,
  isNsmDeletionDetectionEnabled,
} from '../../utils/source-deletion-detection.utils';
import { isNsmCrawlerEnabled } from '../../utils/crawler-activation.utils';
import {
  canonicalizeProposalReason,
  canonicalizeProposalReasonForComparison,
} from '../../utils/proposal-reason.utils';
import {
  recoverCompetentAuthorityName,
  recoverOptionalCompetentAuthorityName,
} from '../crawling/utils/competent-authority-autocomplete.utils';
import { extractProposerName } from '../../utils/proposer.utils';

export interface ArchiveListQuery {
  page: number;
  limit: number;
  search?: string;
  proposer?: string;
  startDate?: Date;
  endDate?: Date;
  sortOrder?: 'asc' | 'desc';
  isDone?: boolean;
}

export interface ArchiveOffsetQuery {
  skip: number;
  take: number;
  search?: string;
  proposer?: string;
  startDate?: Date;
  endDate?: Date;
  sortOrder?: 'asc' | 'desc';
  isDone?: boolean;
  /** Pre-computed total; when provided, the COUNT query is skipped. */
  knownTotal?: number;
}

export interface ArchiveNumCompareCountQuery {
  num: number;
  operator: 'gt' | 'lt';
  search?: string;
  proposer?: string;
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
    captureStatus: string | null;
    captureError: string | null;
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

/** Which NULL snapshot artifact groups were filled by a one-time backfill. */
export interface SnapshotArtifactFillResult {
  html: boolean;
  httpMetadata: boolean;
  screenshot: boolean;
}

export const INTEGRITY_SKIP_REASON_MISSING_SOURCE = 'missing_source_or_hash';

/**
 * Bound notices per `notice_archives` UPDATE when stamping list sightings.
 * Keeps every statement far below SQLite's bound-parameter ceiling while a
 * single cycle still stamps a full list (~16k rows) on a handful of queries.
 */
const NSM_LIST_SEEN_STAMP_CHUNK_SIZE = 400;

type TrackedArchiveRow = Pick<
  NoticeArchive,
  | 'noticeNum'
  | 'contentId'
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

  /**
   * Chain-head fields the default detail response overlays on top of the
   * immutable snapshot, beyond the list-item subset applied by
   * `applyCurrentOverlayFromDiffchain`.
   *
   * The revision-aware path (`applyRevisionOverlay`) serves every tracked
   * field at `?rev=headRev`, but the default response carried only the
   * list-item subset - so a repair that filled the bill number, proposer,
   * proposal date or proposal session stayed invisible in the UI while
   * `revision.resolvedRev` already pointed at the chain head. `isDone` is
   * deliberately absent: it lives in the summary-state table, mirroring the
   * excluded field of the revision-aware path.
   */
  private readonly detailChainHeadFieldPaths = [
    'billNumber',
    'contentBillNumber',
    'proposer',
    'contentProposer',
    'proposalDate',
    'contentProposalDate',
    'contentCommittee',
    'referralDate',
    'contentReferralDate',
    'noticePeriod',
    'contentNoticePeriod',
    'proposalSession',
    'contentProposalSession',
  ] as const;

  constructor(
    @InjectRepository(NoticeArchive)
    private readonly archiveRepository: Repository<NoticeArchive>,
    @InjectRepository(NoticeArchiveSnapshotState)
    private readonly summaryStateRepository: Repository<NoticeArchiveSnapshotState>,
    private readonly changeTrackingService: ChangeTrackingService,
    private readonly discordBridge: DiscordBridgeService,
    @InjectRepository(NoticeArchiveIntegrityCheck)
    private readonly integrityCheckRepository: Repository<NoticeArchiveIntegrityCheck>,
    @InjectRepository(NoticeArchiveIntegrityState)
    private readonly integrityStateRepository: Repository<NoticeArchiveIntegrityState>,
  ) {
    this.artifactSupport = new NoticeArchiveArtifactSupport(
      this.archiveRepository,
      this.integrityCheckRepository,
      this.integrityStateRepository,
      this.summaryStateRepository,
    );
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

  private preferIncomingTrackedValue<T>(
    incoming: T | null | undefined,
    existing: T | null | undefined,
    options?: {
      preserveExistingWhenIncomingNull?: boolean;
      normalizeText?: boolean;
      normalizeTextValue?: (value: string) => string | null;
    },
  ): T | null {
    const preserve = options?.preserveExistingWhenIncomingNull ?? false;
    const normalizeText = options?.normalizeText ?? false;

    if (normalizeText) {
      const normalize = (value: T | null | undefined): T | null => {
        if (typeof value !== 'string') {
          return (value ?? null) as T | null;
        }

        const normalized = options?.normalizeTextValue
          ? options.normalizeTextValue(value)
          : value.replace(/\s+/g, ' ').trim();
        return (
          normalized && normalized.length > 0 ? normalized : null
        ) as T | null;
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
    const take = Math.max(1, Math.min(batchSize, 2000));
    const startedAt = Date.now();
    const scanned = await this.archiveRepository.count();
    let cursorNoticeNum = 0;
    let seeded = 0;

    LoggerUtils.log(
      NoticeArchiveService.name,
      `Legacy genesis started: archiveTotal=${scanned} batchSize=${take}`,
    );

    while (true) {
      const rows = await this.getGenesisCandidateRows(cursorNoticeNum, take);
      if (rows.length === 0) {
        break;
      }

      cursorNoticeNum = rows[rows.length - 1].noticeNum;

      const existingEventNoticeNums =
        await this.changeTrackingService.getNoticeNumsWithAnyEvent(
          rows.map((row) => row.noticeNum),
        );

      for (const row of rows) {
        if (existingEventNoticeNums.has(row.noticeNum)) {
          continue;
        }

        const afterSnapshot = this.buildTrackedSnapshot(row);
        if (!afterSnapshot) {
          continue;
        }

        const built = this.changeTrackingService.buildDiffEvent({
          noticeNum: row.noticeNum,
          beforeSnapshot: null,
          afterSnapshot,
          detectedAt: boundaryAt,
          source: LEGACY_GENESIS_SOURCE,
          preferredEventType: CHANGE_EVENT_TYPE.CREATED,
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
          continue;
        }

        seeded += 1;
      }

      LoggerUtils.log(
        NoticeArchiveService.name,
        `Legacy genesis progress: cursor=${cursorNoticeNum} candidates=${rows.length} seeded=${seeded}`,
      );
    }

    const skipped = Math.max(0, scanned - seeded);
    LoggerUtils.log(
      NoticeArchiveService.name,
      `Legacy genesis completed: archiveTotal=${scanned} seeded=${seeded} skipped=${skipped} elapsedMs=${Date.now() - startedAt}`,
    );

    return {
      boundaryAt: boundaryAt.toISOString(),
      scanned,
      seeded,
      skipped,
    };
  }

  private async getGenesisCandidateRows(
    afterNoticeNum: number,
    take: number,
  ): Promise<TrackedArchiveRow[]> {
    const rows = await this.archiveRepository
      .createQueryBuilder('archive')
      .select([
        'archive.noticeNum',
        'archive.contentId',
        'archive.subject',
        'archive.proposerCategory',
        'archive.committee',
        'archive.proposalReason',
        'archive.contentBillNumber',
        'archive.contentProposer',
        'archive.contentProposalDate',
        'archive.contentCommittee',
        'archive.contentReferralDate',
        'archive.contentNoticePeriod',
        'archive.contentProposalSession',
        'archive.lifecycleStatus',
        'archive.sourceDeletedAt',
      ])
      .where('archive.noticeNum > :afterNoticeNum', { afterNoticeNum })
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM notice_change_events event
          WHERE event.notice_num = archive.noticeNum
        )`,
      )
      .orderBy('archive.noticeNum', 'ASC')
      .take(take)
      .getMany();

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

    const baselineSnapshot = existing
      ? await this.buildDiffBaselineSnapshot(notice.num, beforeRow)
      : null;

    const baselineText = (fieldPath: string): string | null => {
      if (!baselineSnapshot) {
        return null;
      }

      const raw = baselineSnapshot[fieldPath];
      if (raw === null || raw === undefined) {
        return null;
      }

      if (typeof raw === 'string') {
        if (fieldPath === 'proposalReason') {
          return canonicalizeProposalReason(raw);
        }
        const normalized = raw.replace(/\s+/g, ' ').trim();
        return normalized.length > 0 ? normalized : null;
      }

      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return String(raw);
      }

      return null;
    };

    const baselineBool = (fieldPath: string): boolean | null => {
      if (!baselineSnapshot) {
        return null;
      }

      const raw = baselineSnapshot[fieldPath];
      return typeof raw === 'boolean' ? raw : null;
    };

    const fallbackProposalReason =
      canonicalizeProposalReason(baselineText('proposalReason')) ??
      canonicalizeProposalReason(beforeRow?.proposalReason) ??
      null;
    const fallbackBillNumber =
      this.normalizeStableId(baselineText('billNumber')) ??
      this.normalizeStableId(beforeRow?.contentBillNumber);
    const fallbackProposer =
      baselineText('proposer') ?? beforeRow?.contentProposer ?? null;
    const fallbackProposalDate =
      baselineText('proposalDate') ?? beforeRow?.contentProposalDate ?? null;
    const fallbackContentCommittee =
      baselineText('contentCommittee') ?? beforeRow?.contentCommittee ?? null;
    const fallbackReferralDate =
      baselineText('referralDate') ?? beforeRow?.contentReferralDate ?? null;
    const fallbackNoticePeriod =
      baselineText('noticePeriod') ?? beforeRow?.contentNoticePeriod ?? null;
    const fallbackProposalSession =
      baselineText('proposalSession') ??
      beforeRow?.contentProposalSession ??
      null;
    const fallbackContentId =
      this.normalizeStableId(baselineText('contentId')) ??
      this.normalizeStableId(beforeRow?.contentId);
    const isNsmRecrawlAfterPalUpgrade =
      existing && normalizedContentId === null && fallbackContentId !== null;

    const resolvedProposalReason = this.preferIncomingTrackedValue(
      isNsmRecrawlAfterPalUpgrade ? null : originalContent.proposalReason,
      fallbackProposalReason,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
        normalizeTextValue: canonicalizeProposalReason,
      },
    );

    const resolvedContentBillNumber = this.preferIncomingTrackedValue(
      isNsmRecrawlAfterPalUpgrade
        ? null
        : this.normalizeStableId(originalContent.billNumber),
      fallbackBillNumber,
      { preserveExistingWhenIncomingNull: existing },
    );

    const resolvedContentProposer = this.preferIncomingTrackedValue(
      isNsmRecrawlAfterPalUpgrade
        ? null
        : originalContent.proposer?.trim() || null,
      fallbackProposer,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentProposalDate = this.preferIncomingTrackedValue(
      isNsmRecrawlAfterPalUpgrade
        ? null
        : originalContent.proposalDate?.trim() || null,
      fallbackProposalDate,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentCommittee = this.preferIncomingTrackedValue(
      isNsmRecrawlAfterPalUpgrade
        ? null
        : originalContent.committee?.trim() || null,
      fallbackContentCommittee,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentReferralDate = this.preferIncomingTrackedValue(
      isNsmRecrawlAfterPalUpgrade
        ? null
        : originalContent.referralDate?.trim() || null,
      fallbackReferralDate,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentNoticePeriod = this.preferIncomingTrackedValue(
      isNsmRecrawlAfterPalUpgrade
        ? null
        : originalContent.noticePeriod?.trim() || null,
      fallbackNoticePeriod,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedContentProposalSession = this.preferIncomingTrackedValue(
      isNsmRecrawlAfterPalUpgrade
        ? null
        : originalContent.proposalSession?.trim() || null,
      fallbackProposalSession,
      {
        preserveExistingWhenIncomingNull: existing,
        normalizeText: true,
      },
    );

    const resolvedNoticeCommittee = recoverCompetentAuthorityName(
      isNsmRecrawlAfterPalUpgrade
        ? (baselineText('committee') ?? beforeRow?.committee ?? '')
        : notice.committee,
      {
        preferredKinds: ['committee', 'ministry', 'agency'],
      },
    );

    const resolvedRecoveredContentCommittee =
      recoverOptionalCompetentAuthorityName(resolvedContentCommittee, {
        preferredKinds: ['committee', 'agency', 'ministry'],
      });

    const resolvedIsDone =
      originalContent.isDone !== undefined
        ? originalContent.isDone
        : (baselineBool('isDone') ?? beforeRow?.isDone ?? false);

    // Core content fields - always written on both INSERT and UPDATE.
    const coreFields = {
      noticeNum: notice.num,
      subject: isNsmRecrawlAfterPalUpgrade
        ? (baselineText('subject') ?? beforeRow?.subject ?? notice.subject)
        : notice.subject,
      proposerCategory: isNsmRecrawlAfterPalUpgrade
        ? (baselineText('proposerCategory') ??
          beforeRow?.proposerCategory ??
          notice.proposerCategory)
        : notice.proposerCategory,
      committee: resolvedNoticeCommittee,
      assemblyLink: notice.link,
      contentId: isNsmRecrawlAfterPalUpgrade
        ? fallbackContentId
        : normalizedContentId,
      proposalReason: resolvedProposalReason ?? '',
      sourceTitle: originalContent.title?.trim() || notice.subject,
      contentBillNumber: resolvedContentBillNumber,
      contentProposer: resolvedContentProposer,
      contentProposalDate: resolvedContentProposalDate,
      contentCommittee: resolvedRecoveredContentCommittee,
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
      lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
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
          lifecycleStatus: NOTICE_LIFECYCLE_STATUS.RENUMBERED,
        };
        await this.appendExplicitEventWithDiff({
          noticeNum: previousNoticeNum,
          source: NoticeChangeSource.ARCHIVE_RENUMBERED,
          eventType: CHANGE_EVENT_TYPE.INVALIDATED,
          beforeSnapshot,
          afterSnapshot: invalidatedSnapshot,
          subject: beforeRow.subject,
        });
      }
    }

    if (existing) {
      // Strict immutability: existing archive rows are never updated.
      // Any observed changes are represented only as appended diffchain events.
      // Sole exception: snapshot artifact columns that are still NULL may be
      // filled exactly once so a failed first capture is recoverable.
      await this.fillMissingSnapshotArtifacts(notice.num, {
        sourceHtml: originalContent.sourceHtml ?? null,
        htmlSha256: originalContent.htmlSha256 ?? null,
        httpMetadata: normalizedHttpMetadata,
        screenshotBlob: originalContent.screenshotBlob ?? null,
        screenshotFormat: originalContent.screenshotFormat ?? null,
      });
    } else {
      await this.archiveRepository.save(
        this.archiveRepository.create({
          ...coreFields,
          screenshotBlob: originalContent.screenshotBlob ?? null,
          screenshotFormat: originalContent.screenshotFormat ?? null,
        }),
      );

      if (!coreFields.sourceHtml || !coreFields.sourceHtmlSha256) {
        await this.seedIntegrityDeficit(notice.num);
      }
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

    // When the existing record is already source_deleted (detected via
    // the change event chain, not the DB column which remains immutable),
    // preserve its lifecycle status in the diff event to avoid emitting a
    // spurious "restoration" event that flips the bill back to active.
    const baselineLifecycleStatus = baselineSnapshot?.lifecycleStatus;
    const isAlreadySourceDeleted =
      existing &&
      baselineLifecycleStatus === NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED;
    const diffLifecycleStatus = isAlreadySourceDeleted
      ? NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED
      : coreFields.lifecycleStatus;
    const diffSourceDeletedAt = isAlreadySourceDeleted
      ? (baselineSnapshot?.sourceDeletedAt ?? null)
      : coreFields.sourceDeletedAt;

    await this.appendTrackedDiffEvent(
      notice.num,
      NoticeChangeSource.ARCHIVE_UPSERT,
      beforeRow,
      {
        noticeNum: coreFields.noticeNum,
        contentId: coreFields.contentId,
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
        lifecycleStatus: diffLifecycleStatus,
        sourceDeletedAt: diffSourceDeletedAt,
      },
    );
  }

  /**
   * Counts how many of the given notices would actually flip to isDone=true
   * (i.e. the rows `markNoticesDoneByNums` would update).
   *
   * Advisory pre-check only: it lets the isDone sync phase detect a bulk-flip
   * storm and suppress change notifications *before* any event is dispatched.
   * The authoritative flip still happens in `markNoticesDoneByNums`.
   */
  async countNotDoneByNoticeNums(nums: number[]): Promise<number> {
    if (!this.summaryStateRepository || nums.length === 0) {
      return 0;
    }

    const uniqueNums = Array.from(new Set(nums));
    const pendingRows = await this.summaryStateRepository.find({
      where: {
        noticeNum: In(uniqueNums),
        isDone: false,
      },
      select: {
        noticeNum: true,
      },
    });

    return pendingRows.length;
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

      await this.appendIsDoneSyncDiffEvent(noticeNum, beforeRow, true);
    }

    return result.affected ?? 0;
  }

  /**
   * Counts archive rows from earlier Assemblies that are still marked active.
   *
   * Notice numbers encode their Assembly (`<assembly><5-digit serial>`), so
   * rows below `BACKFILL_MIN_NOTICE_NUM` belong to an Assembly whose
   * completed-notice listing is no longer published: the isDone sync fetch can
   * never return them, and without an explicit rule they stay active forever.
   */
  async countLegacyNotDoneNotices(): Promise<number> {
    if (!this.summaryStateRepository) {
      return 0;
    }

    return this.summaryStateRepository.count({
      where: {
        noticeNum: LessThan(APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM),
        isDone: false,
      },
    });
  }

  /**
   * Marks archive rows from earlier Assemblies as done.
   *
   * The isDone sync only flips rows present in the fetched completed-notice
   * listing, which covers the current Assembly alone. Rows below
   * `BACKFILL_MIN_NOTICE_NUM` finished their notice periods years ago, so they
   * are flipped unconditionally through the same `markNoticesDoneByNums` path
   * (diffchain events included).
   * @returns Number of rows actually changed
   */
  async markLegacyNoticesDone(): Promise<number> {
    if (!this.summaryStateRepository) {
      return 0;
    }

    const legacyRows = await this.summaryStateRepository.find({
      where: {
        noticeNum: LessThan(APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM),
        isDone: false,
      },
      select: {
        noticeNum: true,
      },
    });

    if (legacyRows.length === 0) {
      return 0;
    }

    return this.markNoticesDoneByNums(legacyRows.map((row) => row.noticeNum));
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

      await this.appendIsDoneSyncDiffEvent(noticeNum, beforeRow, false);
    }

    return result.affected ?? 0;
  }

  /**
   * Reconciles a completed NSM-shaped list scan against the archive: records
   * when each returned notice was last seen, then marks active NSM-originated
   * rows (contentId IS NULL) whose list absence is confirmed by a detail-page
   * probe as source_deleted.
   *
   * This catches bills that have been removed from the NSM list entirely (not
   * just from a detail page). It runs at the end of the pending-sync phase,
   * after the full list crawl completed.
   *
   * **Two signals decide who is worth probing** (both were added because "every
   * active row the latest scan did not return" is not a candidate set — with a
   * pending-only list such as LIKMS `계류의안` in front of an NSM archive it was
   * ~10k rows, re-probed identically on every 20-minute cycle):
   *
   * - `nsm_last_seen_in_list_at` is stamped for every notice this scan returned,
   *   so absence becomes an episode that starts when a previously seen row stops
   *   being returned (`nsmLastSeenInListAt < scannedAt`). Rows stamped by this
   *   very scan are therefore never candidates.
   * - `nsm_list_absence_probed_at` is stamped whenever a probe investigates a
   *   row without confirming a deletion, which keeps that row out of the
   *   candidate set for `cooldownHours`. A bill that merely dropped off the
   *   listing, or a source that refuses every request, stops reproducing the
   *   same candidate set every cycle.
   *
   * Rows never returned by a list scan (`NULL`) stay eligible, but only as
   * filler behind the rows that newly disappeared and only under the same
   * cooldown, so an archive that predates this tracking drains at
   * `maxCandidates` per pass instead of being swept in one go.
   *
   * Absence from one list scan is NOT sufficient evidence of deletion (a bill
   * can legitimately drop off the listing while its detail page still exists,
   * or a page can be missed by a flaky scan), so `confirmDeletion` must
   * independently confirm it. It may return a plain boolean (confirmed / not
   * confirmed, the legacy contract) or a probe outcome, which separates "the
   * detail page was read and the bill is still listed" from "the response could
   * not be read at all" (portal error page, Waitingroom, network failure). A
   * pass that reads no page at all is aborted early instead of hammering a
   * source that is refusing every request.
   *
   * At most `options.maxCandidates` rows are probed per pass, oldest list
   * absence first, then never-seen rows.
   *
   * @returns Number of rows marked source_deleted in this pass
   */
  async markSourceDeletedByMissingNsmNums(
    seenNsmActiveNums: Set<number>,
    confirmDeletion?: (
      billNo: string,
    ) => Promise<boolean | NsmDeletionProbeOutcome>,
    options?: {
      maxCandidates?: number;
      unusableAbortThreshold?: number;
      cooldownHours?: number;
    },
  ): Promise<number> {
    // A disabled NSM crawler means no NSM list was collected, so there is no
    // reconciliation to run: skip entirely (no stamping, no candidate query,
    // no marking).
    if (!isNsmCrawlerEnabled()) {
      LoggerUtils.debugDev(
        'NoticeArchiveService',
        'markSourceDeletedByMissingNsmNums: NSM crawler is disabled (CRAWLING_NSM_ENABLED); skipped list reconciliation',
      );
      return 0;
    }

    if (seenNsmActiveNums.size === 0) {
      // An empty seen-set is a failed list scan, not a list that lost every
      // bill: nothing is stamped and nothing is probed. (The caller reports the
      // zero-row scan itself.)
      return 0;
    }

    const scannedAt = new Date();
    const stampedCount = await this.stampNsmListSeen(
      seenNsmActiveNums,
      scannedAt,
    );

    // Runtime kill switch: when deletion detection is disabled via
    // CRAWLING_NSM_DELETION_DETECTION_ENABLED, only the sightings above are
    // recorded — no candidate query and no marking. Stamping still happens so
    // re-enabling detection resumes with "rows that disappeared while it was
    // off" instead of treating the whole archive as never-seen.
    if (!isNsmDeletionDetectionEnabled()) {
      LoggerUtils.log(
        'NoticeArchiveService',
        `markSourceDeletedByMissingNsmNums: recorded ${stampedCount} list sighting(s) and skipped the probe pass — ${describeNsmDeletionDetectionDisabled()}`,
      );
      return 0;
    }

    const maxCandidates =
      options?.maxCandidates ??
      APP_CONSTANTS.ARCHIVE_SYNC.NSM_MISSING_PROBE_MAX_CANDIDATES;
    const unusableAbortThreshold =
      options?.unusableAbortThreshold ??
      APP_CONSTANTS.ARCHIVE_SYNC.NSM_MISSING_PROBE_UNUSABLE_ABORT_THRESHOLD;
    const cooldownHours =
      options?.cooldownHours ??
      APP_CONSTANTS.ARCHIVE_SYNC.NSM_LIST_ABSENCE_REPROBE_COOLDOWN_HOURS;
    const cooldownCutoff = new Date(
      scannedAt.getTime() - Math.max(0, cooldownHours) * 60 * 60 * 1000,
    );

    if (maxCandidates <= 0) {
      return 0;
    }

    // Disappeared rows first (a previously seen row that this scan did not
    // return), then never-seen rows filling the remaining slots.
    const disappearedRows = await this.findNsmListAbsenceCandidates({
      scannedAt,
      cooldownCutoff,
      limit: maxCandidates,
      includeNeverSeen: false,
    });
    const remainingSlots = Math.max(0, maxCandidates - disappearedRows.length);
    const neverSeenRows =
      remainingSlots > 0
        ? await this.findNsmListAbsenceCandidates({
            scannedAt,
            cooldownCutoff,
            limit: remainingSlots,
            includeNeverSeen: true,
          })
        : [];
    const candidates = [...disappearedRows, ...neverSeenRows];

    LoggerUtils.log(
      'NoticeArchiveService',
      `markSourceDeletedByMissingNsmNums: seen=${seenNsmActiveNums.size}, stamped=${stampedCount}, disappeared=${disappearedRows.length}, neverSeen=${neverSeenRows.length}, probing=${candidates.length} (cap=${maxCandidates}, cooldownHours=${cooldownHours})`,
    );

    if (candidates.length === 0) {
      return 0;
    }

    let markedCount = 0;
    let probedCount = 0;
    let readableCount = 0;
    let unreadableCount = 0;

    for (const row of candidates) {
      if (confirmDeletion) {
        const billNo = row.contentBillNumber ?? row.noticeNum.toString();
        const result = await confirmDeletion(billNo);
        probedCount++;

        // A boolean result carries no reason, so it keeps the legacy meaning:
        // false means "checked, not confirmed" and is reported as still-listed.
        const outcome: NsmDeletionProbeOutcome =
          typeof result === 'string' ? result : result ? 'deleted' : 'alive';

        if (outcome !== 'deleted') {
          if (outcome === 'alive') {
            readableCount++;
          } else {
            unreadableCount++;
          }

          // Record the investigation so this row drops out of the candidate
          // set for the cooldown. A `blocked`/`error` outcome is stamped too:
          // the pass learned nothing, and re-probing the same rows while the
          // source refuses every request is exactly the loop that turned one
          // blocked portal into a per-cycle sweep of the whole pool.
          if (outcome !== 'disabled') {
            await this.markNsmListAbsenceProbed(row.noticeNum, scannedAt);
          }

          LoggerUtils.debugDev(
            'NoticeArchiveService',
            `markSourceDeletedByMissingNsmNums: notice ${row.noticeNum} missing from list scan but ${this.describeProbeOutcome(outcome)}; left active`,
          );

          if (
            unreadableCount >= unusableAbortThreshold &&
            readableCount === 0
          ) {
            logAndBridge({
              logger: this.logger,
              method: 'warn',
              message: `markSourceDeletedByMissingNsmNums: aborted after ${unreadableCount} unreadable probes with no readable detail page — the notice source is refusing or failing every request, so the remaining ${candidates.length - probedCount} candidate(s) were skipped`,
              context: NoticeArchiveService.name,
              discordBridge: this.discordBridge,
              bridgeLevel: BridgeLogLevel.WARN,
              metadata: {
                candidates: candidates.length,
                probed: probedCount,
                outcome,
              },
            });
            break;
          }

          continue;
        }
      }

      try {
        await this.appendSourceDeletedEventByNoticeNum(row.noticeNum);
        markedCount++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `markSourceDeletedByMissingNsmNums: failed to mark notice ${row.noticeNum} as source_deleted: ${message}`,
        );
      }
    }

    if (unreadableCount > 0) {
      this.logger.warn(
        `markSourceDeletedByMissingNsmNums: ${unreadableCount} of ${probedCount} probe(s) returned no readable detail page (blocked or failed); deletion detection is degraded`,
      );
    }

    return markedCount;
  }

  /**
   * Records `seenAt` as the last list-scan sighting of every notice the scan
   * returned, in chunks that stay well under SQLite's bound-parameter limit.
   *
   * Rows already stamped at or after `seenAt` are left untouched, so a second
   * scan in the same cycle (the cron pending pass and the archive-sync pending
   * phase both run this) does not rewrite the whole set again. Only the two
   * tracking columns change, which the archive immutability trigger allows.
   *
   * @returns Number of rows whose sighting was actually refreshed
   */
  async stampNsmListSeen(
    noticeNums: Iterable<number>,
    seenAt: Date,
  ): Promise<number> {
    const uniqueNums = Array.from(new Set(noticeNums)).filter(
      (noticeNum) => Number.isInteger(noticeNum) && noticeNum > 0,
    );

    if (uniqueNums.length === 0) {
      return 0;
    }

    let stampedCount = 0;

    for (
      let offset = 0;
      offset < uniqueNums.length;
      offset += NSM_LIST_SEEN_STAMP_CHUNK_SIZE
    ) {
      const chunk = uniqueNums.slice(
        offset,
        offset + NSM_LIST_SEEN_STAMP_CHUNK_SIZE,
      );
      const result = await this.archiveRepository.update(
        {
          noticeNum: In(chunk),
          nsmLastSeenInListAt: Or(IsNull(), LessThan(seenAt)),
        },
        { nsmLastSeenInListAt: seenAt },
      );
      stampedCount += result?.affected ?? 0;
    }

    return stampedCount;
  }

  /**
   * Selects the rows whose list absence is worth a detail probe this pass.
   *
   * `includeNeverSeen: false` returns rows this scan dropped after an earlier
   * sighting (oldest disappearance first, so one capped pass cannot starve the
   * rest of the pool); `includeNeverSeen: true` returns rows no list scan has
   * returned since the tracking columns were added. Both groups exclude rows
   * probed within the cooldown, and only active NSM-originated rows are
   * considered (a PAL row is not in the NSM list by design).
   */
  private async findNsmListAbsenceCandidates(params: {
    scannedAt: Date;
    cooldownCutoff: Date;
    limit: number;
    includeNeverSeen: boolean;
  }): Promise<Array<{ noticeNum: number; contentBillNumber: string | null }>> {
    const { scannedAt, cooldownCutoff, limit, includeNeverSeen } = params;

    if (limit <= 0) {
      return [];
    }

    return this.archiveRepository.find({
      where: {
        lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
        contentId: IsNull(),
        sourceDeletedAt: IsNull(),
        nsmLastSeenInListAt: includeNeverSeen ? IsNull() : LessThan(scannedAt),
        nsmListAbsenceProbedAt: Or(IsNull(), LessThan(cooldownCutoff)),
      },
      select: {
        noticeNum: true,
        contentBillNumber: true,
      },
      order: includeNeverSeen
        ? { noticeNum: 'ASC' }
        : { nsmLastSeenInListAt: 'ASC' },
      take: limit,
    });
  }

  /**
   * Records that a row's list absence was investigated without a confirmed
   * deletion, which keeps it out of the candidate set for the cooldown.
   */
  private async markNsmListAbsenceProbed(
    noticeNum: number,
    probedAt: Date,
  ): Promise<void> {
    try {
      await this.archiveRepository.update(
        { noticeNum },
        { nsmListAbsenceProbedAt: probedAt },
      );
    } catch (error) {
      // Throttling is an optimisation, not a correctness requirement: losing a
      // stamp means the row may be probed again next cycle, which must never
      // abort the pass or hide a confirmed deletion elsewhere in it.
      this.logger.warn(
        `markSourceDeletedByMissingNsmNums: failed to record list-absence probe for notice ${noticeNum}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Turns a probe outcome into the reason phrase used by the reconciliation
   * log, so a blocked or failed read is never reported as a live bill.
   */
  private describeProbeOutcome(outcome: NsmDeletionProbeOutcome): string {
    switch (outcome) {
      case 'alive':
        return 'still present on the detail page';
      case 'blocked':
        return 'the detail response was unreadable (portal error page or Waitingroom)';
      case 'disabled':
        return describeNsmDeletionDetectionDisabled();
      default:
        return 'the detail probe failed';
    }
  }

  /**
   * Returns a batch of active NSM-originated archive rows (contentId IS NULL)
   * for detail-page probe.  Each row has noticeNum and contentBillNumber so
   * the caller can issue an NSM detail-page request to check for deletion.
   */
  async getActiveNsmBillsForProbe(
    limit: number,
  ): Promise<Array<{ noticeNum: number; contentBillNumber: string | null }>> {
    if (limit <= 0) return [];

    // Priority 1: probe bills whose detail page was never successfully
    // captured (content_bill_number IS NULL) - the strongest candidates for
    // having been deleted on the NSM portal. Random order (rather than a
    // fixed noticeNum DESC slice) so that when this pool is >= limit, the
    // same top-N rows aren't probed forever while the rest of the pool never
    // gets checked.
    const highPriority = await this.archiveRepository
      .createQueryBuilder('archive')
      .where('archive.lifecycleStatus = :status', {
        status: NOTICE_LIFECYCLE_STATUS.ACTIVE,
      })
      .andWhere('archive.contentId IS NULL')
      .andWhere('archive.contentBillNumber IS NULL')
      .andWhere('archive.sourceDeletedAt IS NULL')
      .select(['archive.noticeNum', 'archive.contentBillNumber'])
      .orderBy('RANDOM()')
      .limit(limit)
      .getMany();

    if (highPriority.length >= limit) {
      return highPriority.slice(0, limit);
    }

    // Priority 2: fill remaining slots from the broader pool, random order
    // for the same eventual-coverage reason as Priority 1.
    const remaining = limit - highPriority.length;
    if (remaining <= 0) return highPriority;

    const filler = await this.archiveRepository
      .createQueryBuilder('archive')
      .where('archive.lifecycleStatus = :status', {
        status: NOTICE_LIFECYCLE_STATUS.ACTIVE,
      })
      .andWhere('archive.contentId IS NULL')
      .andWhere('archive.sourceDeletedAt IS NULL')
      .select(['archive.noticeNum', 'archive.contentBillNumber'])
      .orderBy('RANDOM()')
      .limit(remaining)
      .getMany();

    return [...highPriority, ...filler];
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
      beforeSnapshot.lifecycleStatus === NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED;

    // Ensure summary_state has isDone=true even when the change event
    // already exists — a prior marking may have created the event but
    // failed to flip the summary marker.
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

    if (alreadySourceDeleted) {
      return;
    }

    const deletedAt = new Date().toISOString();
    const afterSnapshot = {
      ...beforeSnapshot,
      isDone: true,
      lifecycleStatus: NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED,
      sourceDeletedAt: deletedAt,
    };

    await this.appendExplicitEventWithDiff({
      noticeNum,
      source: NoticeChangeSource.ARCHIVE_SOURCE_MISSING,
      eventType: CHANGE_EVENT_TYPE.INVALIDATED,
      beforeSnapshot,
      afterSnapshot,
      subject: beforeRow.subject,
    });

    // Persist lifecycle_status + source_deleted_at on the archive row itself
    // so probe queries (getActiveNsmBillsForProbe) no longer return this bill.
    // Without this the DB row stays lifecycleStatus='active' and the probe
    // re-discovers the same deleted bills every cycle.
    try {
      const parsedDeletedAt = new Date(deletedAt);
      await this.archiveRepository.update({ noticeNum }, {
        lifecycleStatus: NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED,
        sourceDeletedAt: Number.isNaN(parsedDeletedAt.getTime())
          ? new Date()
          : parsedDeletedAt,
      } as any);
    } catch (updateErr) {
      this.logger.warn(
        `Failed to persist source_deleted on archive row ${noticeNum}: ${(updateErr as Error).message}`,
      );
    }
  }

  /**
   * One-time-per-run repair for rows whose diffchain already recorded an
   * INVALIDATED (source_deleted/renumbered) event but whose `notice_archives`
   * row still shows `lifecycle_status='active'` - the state left behind by
   * rows marked before the immutability trigger allowed this transition.
   * Without this repair, every probe/candidate-selection query that trusts
   * the `lifecycle_status` column keeps re-discovering and re-logging these
   * already-deleted bills forever. Safe to call repeatedly; only touches
   * rows where the column is confirmed stale against the diffchain.
   */
  async reconcileStaleLifecycleStatuses(): Promise<number> {
    if (!this.changeTrackingService) return 0;

    const invalidatedNums =
      await this.changeTrackingService.getNoticeNumsWithInvalidatedEvent();
    if (invalidatedNums.size === 0) return 0;

    const staleRows = await this.archiveRepository.find({
      where: {
        noticeNum: In(Array.from(invalidatedNums)),
        lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
      },
      select: { noticeNum: true },
    });

    if (staleRows.length === 0) return 0;

    let fixedCount = 0;
    for (const row of staleRows) {
      try {
        const latestLifecycleStatus =
          await this.changeTrackingService.getLatestFieldAfterValue(
            row.noticeNum,
            'lifecycleStatus',
          );

        if (
          latestLifecycleStatus !== NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED &&
          latestLifecycleStatus !== NOTICE_LIFECYCLE_STATUS.RENUMBERED
        ) {
          continue;
        }

        const latestSourceDeletedAt =
          await this.changeTrackingService.getLatestFieldAfterValue(
            row.noticeNum,
            'sourceDeletedAt',
          );
        const parsedDeletedAt = latestSourceDeletedAt
          ? new Date(latestSourceDeletedAt)
          : new Date();

        await this.archiveRepository.update({ noticeNum: row.noticeNum }, {
          lifecycleStatus: latestLifecycleStatus,
          sourceDeletedAt: Number.isNaN(parsedDeletedAt.getTime())
            ? new Date()
            : parsedDeletedAt,
        } as any);
        fixedCount++;
      } catch (error) {
        this.logger.warn(
          `reconcileStaleLifecycleStatuses: failed to fix notice ${row.noticeNum}: ${(error as Error).message}`,
        );
      }
    }

    return fixedCount;
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
   * `'not_supported'` so legacy rows that were prematurely marked not_supported
   * can re-enter the backfill pipeline once proposalReason becomes available
   * via change-chain repair. `contentId`-bearing rows are included: the
   * generator resolves their reason through the live payload, a reason the
   * caller already resolved, or the chain head, so excluding them here only
   * made rows whose reason arrived in a later revision unrecoverable.
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
    );
  }

  /**
   * Returns one page of `not_requested` rows for offset-based staging scans.
   * Unlike getPendingSummaryPage, this never falls back to not_supported.
   *
   * Callers advance `skip` by the batch size. The cursor runs over the
   * summary-state rows, so a page shorter than the batch size means the
   * `not_requested` set is exhausted - rows dropped by the active-archive join
   * do not make the page short (see `collectSummaryBackfillCandidates`).
   */
  async getPendingSummaryPageByOffset(
    skip: number,
    take: number,
  ): Promise<CachedNotice[]> {
    return this.collectSummaryBackfillCandidates(
      AI_SUMMARY_STATUS.NOT_REQUESTED,
      skip,
      take,
    );
  }

  /**
   * Returns one page of `not_supported` recovery candidates for offset-based
   * staging scans, regardless of `contentId`.
   *
   * This scan used to skip `contentId`-bearing rows, on the assumption that a
   * row with a PAL content id would always resolve its reason from the live
   * payload. That is not true for rows whose `proposalReason` arrived in a
   * later revision: the archived snapshot column is empty and the live payload
   * still has no reason, while the chain carries the text. Keeping them out of
   * the scan left them `not_supported` forever. The generator now resolves a
   * `contentId` row through the live payload, a caller-resolved reason, or the
   * chain head, so the recovery scan offers them.
   *
   * Callers advance `skip` by the batch size. The cursor runs over the
   * summary-state rows, so rows whose archive turned `source_deleted`
   * (dropped by the active-archive join) no longer end the scan early - that
   * regression left every later recovery candidate unreachable
   * (`agent_memories/38-summary-backfill-recovery-wedge/`).
   */
  async getNotSupportedSummaryRecoveryPage(
    skip: number,
    take: number,
  ): Promise<CachedNotice[]> {
    return this.collectSummaryBackfillCandidates(
      AI_SUMMARY_STATUS.NOT_SUPPORTED,
      skip,
      take,
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
   * the caller must increment `skip` to make forward progress. The cursor runs
   * over the summary-state rows, so only an exhausted `unavailable` set makes
   * a page shorter than the batch size.
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

  /**
   * Collects up to `take` backfill candidates whose `aiSummaryStatus` is
   * `status`, walking the result set with a cursor.
   *
   * The cursor advances over the **summary-state** rows (the source of truth
   * for `aiSummaryStatus`), never over the hydrated rows. A hydrated page is
   * legitimately shorter than its cursor page, because rows whose archive is
   * missing or no longer `active` (`source_deleted`/`renumbered`) are dropped
   * from the join. Reading that shorter array as end-of-data stopped the
   * `not_supported` recovery scan for good at the first inactive row and
   * starved every later candidate - see
   * `agent_memories/38-summary-backfill-recovery-wedge/`.
   *
   * The cursor advances by exactly one page per iteration, so callers keep
   * their `skip += batchSize` contract and a short return still means the
   * cursor source is exhausted.
   */
  private async collectSummaryBackfillCandidates(
    status: AISummaryStatus,
    skip: number,
    take: number,
  ): Promise<CachedNotice[]> {
    const pageSize = Math.max(take, 1);
    const candidates: CachedNotice[] = [];
    let cursor = Math.max(skip, 0);

    for (;;) {
      const page = await this.readSummaryBackfillCursorPage(
        status,
        cursor,
        pageSize,
      );

      if (page.rows.length > 0) {
        candidates.push(
          ...(await this.resolveSummaryBackfillCandidates(page.rows)),
        );
      }

      if (candidates.length >= pageSize || page.cursorCount < pageSize) {
        break;
      }

      cursor += pageSize;
    }

    return candidates.slice(0, pageSize);
  }

  /**
   * Reads one cursor page of summary-backfill rows.
   *
   * `cursorCount` is how many rows the cursor source returned (the
   * summary-state table, or the archive table when no state repository is
   * wired) and is the only value a caller may compare against the page size to
   * detect the end of the scan. `rows` is the hydrated subset that still has
   * an `active` archive row, so it can be shorter than `cursorCount`.
   *
   * The scan starts at the current Assembly (`BACKFILL_MIN_NOTICE_NUM`): bills
   * archived from earlier Assemblies are historical records whose sources
   * publish no detail page, so a summary pass over them can only re-derive
   * `not_supported`. They are the lowest notice numbers in the table, which put
   * them at the head of every page and spent each pass re-confirming what they
   * already hold.
   */
  private async readSummaryBackfillCursorPage(
    status: AISummaryStatus,
    cursor: number,
    take: number,
  ): Promise<{ cursorCount: number; rows: CachedNotice[] }> {
    if (!this.summaryStateRepository) {
      const rows = await this.archiveRepository.find({
        where: {
          aiSummaryStatus: status,
          noticeNum: MoreThanOrEqual(
            APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM,
          ),
        },
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
        skip: cursor,
        take,
      });

      return {
        cursorCount: rows.length,
        rows: rows.map((row) => mapArchiveEntityToCachedNotice(row, status)),
      };
    }

    const summaryRows = await this.summaryStateRepository.find({
      where: {
        aiSummaryStatus: status,
        noticeNum: MoreThanOrEqual(
          APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM,
        ),
      },
      select: {
        noticeNum: true,
        aiSummary: true,
        aiSummaryStatus: true,
      },
      order: {
        noticeNum: 'ASC',
      },
      skip: cursor,
      take,
    });

    const noticeNums = summaryRows.map((row) => row.noticeNum);
    if (noticeNums.length === 0) {
      return { cursorCount: 0, rows: [] };
    }

    const archives = await this.archiveRepository.find({
      where: {
        noticeNum: In(noticeNums),
        lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
      },
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

    const rows = summaryRows
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

    return { cursorCount: summaryRows.length, rows };
  }

  private async resolveSummaryBackfillCandidates(
    rows: CachedNotice[],
  ): Promise<CachedNotice[]> {
    const passthroughRows: CachedNotice[] = [];
    const needChainReasonRows: CachedNotice[] = [];

    for (const row of rows) {
      const snapshotProposalReason = row.proposalReason?.trim() || null;
      if (row.contentId || snapshotProposalReason) {
        passthroughRows.push({
          ...row,
          proposalReason: snapshotProposalReason,
        });
        continue;
      }

      needChainReasonRows.push(row);
    }

    if (needChainReasonRows.length === 0) {
      return passthroughRows;
    }

    const latestProposalReasons = await this.getLatestProposalReasonsForNotices(
      needChainReasonRows.map((row) => row.num),
    );

    const resolvedFromChain: CachedNotice[] = [];
    const unresolvedRows: CachedNotice[] = [];
    for (const row of needChainReasonRows) {
      const latestProposalReason = latestProposalReasons.get(row.num) ?? null;
      if (!latestProposalReason) {
        // Keep unresolved NSM rows in the candidate set so the backfill worker
        // can transition them to UNAVAILABLE instead of starving staging.
        unresolvedRows.push({
          ...row,
          proposalReason: null,
        });
        continue;
      }

      resolvedFromChain.push({
        ...row,
        proposalReason: latestProposalReason,
      });
    }

    return [...passthroughRows, ...resolvedFromChain, ...unresolvedRows];
  }

  private async getLatestProposalReasonsForNotices(
    noticeNums: number[],
  ): Promise<Map<number, string | null>> {
    const uniqueNums = Array.from(new Set(noticeNums));
    const result = new Map<number, string | null>();

    for (const noticeNum of uniqueNums) {
      result.set(noticeNum, null);
    }

    if (uniqueNums.length === 0 || !this.changeTrackingService) {
      return result;
    }

    const svcCompat = this.changeTrackingService as {
      getLatestFieldValues?: (
        nums: number[],
        fieldPath: string,
      ) => Promise<Map<number, string | null>>;
      getLatestFieldValue: (
        num: number,
        fieldPath: string,
      ) => Promise<string | null>;
    };

    if (svcCompat.getLatestFieldValues) {
      try {
        return await svcCompat.getLatestFieldValues(
          uniqueNums,
          'proposalReason',
        );
      } catch (error) {
        this.logger.warn(
          `Failed to load batched proposalReason values from change chain: ${(error as Error).message}`,
        );
      }
    }

    await Promise.all(
      uniqueNums.map(async (noticeNum) => {
        try {
          result.set(
            noticeNum,
            await svcCompat.getLatestFieldValue(noticeNum, 'proposalReason'),
          );
        } catch (error) {
          this.logger.warn(
            `Failed to load latest proposalReason from change chain for notice ${noticeNum}: ${(error as Error).message}`,
          );
        }
      }),
    );

    return result;
  }

  private applyArchiveSearchFilters(
    qb: SelectQueryBuilder<NoticeArchive>,
    params: {
      search?: string;
      proposer?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): void {
    const search = (params.search || '').trim();
    const proposer = (params.proposer || '').trim();

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

    if (proposer) {
      const extractedNames = extractProposerName(proposer);
      const namesToSearch =
        extractedNames.length > 0 ? extractedNames : [proposer];
      qb.andWhere(
        new Brackets((query) => {
          for (let i = 0; i < namesToSearch.length; i++) {
            const paramName = `proposerSearch_${i}`;
            const pattern = `%${namesToSearch[i]}%`;
            if (i === 0) {
              query.where(
                '(archive.contentProposer LIKE :' +
                  paramName +
                  ' OR archive.subject LIKE :' +
                  paramName +
                  ')',
                { [paramName]: pattern },
              );
            } else {
              query.orWhere(
                '(archive.contentProposer LIKE :' +
                  paramName +
                  ' OR archive.subject LIKE :' +
                  paramName +
                  ')',
                { [paramName]: pattern },
              );
            }
          }
        }),
      );
    }

    if (!search) {
      return;
    }

    // proposalReason is always part of a keyword search now. Its
    // body text is far too large for a LIKE scan, so it is matched through the
    // FTS5 index (see the FTS migration); `subject`/`committee`/
    // `contentProposer` keep their LIKE predicates because FTS tokenizes on
    // word boundaries and Korean bill names are single tokens (searching
    // "보호" must still find "상가건물 임대차보호법"). The LIKE fallback only
    // applies when the query has no indexable term at all.
    const ftsQuery = this.buildFtsMatchQuery(search);

    qb.andWhere(
      new Brackets((query) => {
        query
          .where('archive.subject LIKE :search', {
            search: `%${search}%`,
          })
          .orWhere('archive.committee LIKE :search', {
            search: `%${search}%`,
          })
          .orWhere('archive.contentProposer LIKE :search', {
            search: `%${search}%`,
          });

        if (ftsQuery) {
          query.orWhere(
            'archive.rowid IN (SELECT rowid FROM notice_archives_fts WHERE notice_archives_fts MATCH :ftsQuery)',
            { ftsQuery },
          );
        } else {
          query.orWhere('archive.proposalReason LIKE :search', {
            search: `%${search}%`,
          });
        }
      }),
    );
  }

  private buildFtsMatchQuery(search: string): string | null {
    const terms = search
      .trim()
      .split(/\s+/)
      .map((term) =>
        term
          .replace(/["'`]/g, ' ')
          .replace(/[^\p{L}\p{N}_-]/gu, ' ')
          .trim(),
      )
      .filter((term) => term.length > 0)
      .map((term) => `"${term}"*`);

    return terms.length > 0 ? terms.join(' AND ') : null;
  }

  private async queryArchiveNoticeNumsByIsDoneFilter(params: {
    isDone: boolean;
    search?: string;
    proposer?: string;
    startDate?: Date;
    endDate?: Date;
    sortOrder: 'asc' | 'desc';
    skip: number;
    take: number;
    knownTotal?: number;
  }): Promise<{ total: number; noticeNums: number[] }> {
    if (!this.summaryStateRepository) {
      return { total: 0, noticeNums: [] };
    }

    const baseQb = this.archiveRepository.createQueryBuilder('archive').where(
      `EXISTS (
          SELECT 1
          FROM notice_archive_snapshot_states summary
          WHERE summary.notice_num = archive.noticeNum
            AND summary.is_done = :isDone
        )`,
      {
        isDone: params.isDone ? 1 : 0,
      },
    );

    this.applyArchiveSearchFilters(baseQb, params);

    const hasArchiveFilters = Boolean(
      params.search?.trim() ||
      params.proposer?.trim() ||
      params.startDate ||
      params.endDate,
    );
    const total =
      params.knownTotal !== undefined
        ? params.knownTotal
        : hasArchiveFilters
          ? await baseQb.clone().getCount()
          : await this.summaryStateRepository.count({
              where: { isDone: params.isDone },
            });
    if (params.take <= 0) {
      return { total, noticeNums: [] };
    }

    const rows = await baseQb
      .clone()
      .select('archive.noticeNum', 'noticeNum')
      .orderBy('archive.noticeNum', params.sortOrder === 'asc' ? 'ASC' : 'DESC')
      .offset(params.skip)
      .limit(params.take)
      .getRawMany<{ noticeNum: number }>();

    return {
      total,
      noticeNums: rows.map((row) => Number(row.noticeNum)),
    };
  }

  private createArchiveNoticeItemQueryBuilder(
    alias = 'archive',
  ): SelectQueryBuilder<NoticeArchive> {
    return this.archiveRepository
      .createQueryBuilder(alias)
      .select([
        `${alias}.noticeNum`,
        `${alias}.subject`,
        `${alias}.proposerCategory`,
        `${alias}.committee`,
        `${alias}.assemblyLink`,
        `${alias}.contentId`,
        `${alias}.attachmentPdfFile`,
        `${alias}.attachmentHwpFile`,
        `${alias}.lifecycleStatus`,
        `${alias}.sourceDeletedAt`,
        `${alias}.archiveStartedAt`,
      ]);
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
        contentId: true,
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

  private async applyCurrentOverlayFromDiffchain(
    rows: Array<NoticeArchive | CachedNotice>,
  ): Promise<void> {
    if (!this.changeTrackingService || rows.length === 0) {
      return;
    }

    const noticeNums = rows
      .map((row) => ('noticeNum' in row ? row.noticeNum : row.num))
      .filter((num) => Number.isInteger(num) && num > 0);

    if (noticeNums.length === 0) {
      return;
    }

    const latestByNoticeNum =
      await this.changeTrackingService.getLatestFieldValuesForFields(
        noticeNums,
        [
          'subject',
          'proposerCategory',
          'committee',
          'contentId',
          'proposalReason',
          'lifecycleStatus',
          'sourceDeletedAt',
        ],
      );

    for (const row of rows) {
      const noticeNum = 'noticeNum' in row ? row.noticeNum : row.num;
      const fields = latestByNoticeNum.get(noticeNum);
      if (!fields) continue;

      const setRequiredText = (
        fieldPath: 'subject' | 'proposerCategory' | 'committee',
      ) => {
        if (!fields.has(fieldPath)) return;
        const value = fields.get(fieldPath)?.trim();
        if (value) row[fieldPath] = value;
      };
      setRequiredText('subject');
      setRequiredText('proposerCategory');
      setRequiredText('committee');

      if (fields.has('contentId')) {
        row.contentId = this.normalizeStableId(fields.get('contentId'));
      }
      if (fields.has('proposalReason')) {
        const proposalReason = canonicalizeProposalReason(
          fields.get('proposalReason'),
        );
        row.proposalReason =
          'noticeNum' in row ? (proposalReason ?? '') : proposalReason;
      }

      const latestLifecycleStatus = fields.get('lifecycleStatus') ?? null;
      if (
        'lifecycleStatus' in row &&
        (latestLifecycleStatus === NOTICE_LIFECYCLE_STATUS.ACTIVE ||
          latestLifecycleStatus === NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED ||
          latestLifecycleStatus === NOTICE_LIFECYCLE_STATUS.RENUMBERED)
      ) {
        row.lifecycleStatus = latestLifecycleStatus;
      }

      const latestSourceDeletedAt = fields.get('sourceDeletedAt') ?? null;
      if ('sourceDeletedAt' in row && latestSourceDeletedAt) {
        const parsed = new Date(latestSourceDeletedAt);
        if (!Number.isNaN(parsed.getTime())) {
          row.sourceDeletedAt = parsed;
        }
      }
    }
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
    const sortOrder = normalizeSortOrder(query.sortOrder);

    let rows: NoticeArchive[] = [];
    let total: number;

    if (query.isDone !== undefined && this.summaryStateRepository) {
      const paged = await this.queryArchiveNoticeNumsByIsDoneFilter({
        isDone: query.isDone,
        search,
        proposer: query.proposer,
        startDate: query.startDate,
        endDate: query.endDate,
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
      const baseQb = this.createArchiveNoticeItemQueryBuilder('archive');
      this.applyArchiveSearchFilters(baseQb, {
        search,
        proposer: query.proposer,
        startDate: query.startDate,
        endDate: query.endDate,
      });

      const [fetchedRows, fetchedTotal] = await baseQb
        .clone()
        .orderBy('archive.noticeNum', sortOrder === 'asc' ? 'ASC' : 'DESC')
        .offset(skip)
        .limit(limit)
        .getManyAndCount();

      rows = fetchedRows;
      total = fetchedTotal;
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

    await this.applyCurrentOverlayFromDiffchain(rows);

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
    const qb = this.createArchiveNoticeItemQueryBuilder('archive');
    this.applyArchiveSearchFilters(qb, {
      search: normalizedSearch,
    });
    const rows = await qb
      .orderBy('archive.archiveStartedAt', 'DESC')
      .addOrderBy('archive.noticeNum', 'DESC')
      .getMany();

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

    await this.applyCurrentOverlayFromDiffchain(rows);

    return rows.map((row) => mapArchiveEntityToNoticeItem(row));
  }

  /**
   * Fetch archive notices for a pre-ranked list of notice numbers, preserving
   * that rank order and applying the same archive filters (date range,
   * proposer, isDone) as the keyword search path. The semantic board mode uses
   * this to hydrate engine-ranked notice numbers into card rows without
   * letting `noticeNum` ordering overrule relevance.
   *
   * The notice-number list is bounded by the caller (semantic candidate cap),
   * so the whole matching set is fetched and rank-sorted in memory; the caller
   * paginates the returned items.
   */
  async getArchiveNoticesByRankedNums(params: {
    noticeNums: number[];
    proposer?: string;
    startDate?: Date;
    endDate?: Date;
    isDone?: boolean;
  }): Promise<{ items: ArchiveNoticeItem[]; total: number }> {
    const uniqueNums = Array.from(new Set(params.noticeNums)).filter(
      (num) => Number.isInteger(num) && num > 0,
    );

    if (uniqueNums.length === 0) {
      return { items: [], total: 0 };
    }

    const qb = this.createArchiveNoticeItemQueryBuilder('archive');
    qb.andWhere('archive.noticeNum IN (:...rankedNoticeNums)', {
      rankedNoticeNums: uniqueNums,
    });

    // isDone is derived from the snapshot-state table, mirroring the keyword
    // path's EXISTS predicate (queryArchiveNoticeNumsByIsDoneFilter).
    if (params.isDone !== undefined && this.summaryStateRepository) {
      qb.andWhere(
        `EXISTS (
            SELECT 1
            FROM notice_archive_snapshot_states summary
            WHERE summary.notice_num = archive.noticeNum
              AND summary.is_done = :isDone
          )`,
        { isDone: params.isDone ? 1 : 0 },
      );
    }

    this.applyArchiveSearchFilters(qb, {
      proposer: params.proposer,
      startDate: params.startDate,
      endDate: params.endDate,
    });

    const rows = await qb.getMany();
    const rank = new Map(uniqueNums.map((num, idx) => [num, idx] as const));
    rows.sort(
      (a, b) => (rank.get(a.noticeNum) ?? 0) - (rank.get(b.noticeNum) ?? 0),
    );

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

    await this.applyCurrentOverlayFromDiffchain(rows);

    const items = rows.map((row) => mapArchiveEntityToNoticeItem(row));
    return { items, total: items.length };
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

    await this.applyCurrentOverlayFromDiffchain(rows);

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
    const sortOrder = normalizeSortOrder(query.sortOrder);
    const nonDoneBaseQb = this.createArchiveNoticeItemQueryBuilder('archive');
    this.applyArchiveSearchFilters(nonDoneBaseQb, {
      search,
      proposer: query.proposer,
      startDate: query.startDate,
      endDate: query.endDate,
    });

    let total: number;
    let rows: NoticeArchive[] = [];

    // Use knownTotal when provided to avoid a redundant COUNT query.
    if (query.knownTotal !== undefined) {
      total = query.knownTotal;
    } else if (query.isDone !== undefined && this.summaryStateRepository) {
      const paged = await this.queryArchiveNoticeNumsByIsDoneFilter({
        isDone: query.isDone,
        search,
        proposer: query.proposer,
        startDate: query.startDate,
        endDate: query.endDate,
        sortOrder,
        skip,
        take,
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
      total = await nonDoneBaseQb.clone().getCount();
    }

    if (take === 0) {
      return {
        items: [],
        total,
        search,
      };
    }

    if (
      rows.length === 0 &&
      query.isDone !== undefined &&
      this.summaryStateRepository
    ) {
      const paged = await this.queryArchiveNoticeNumsByIsDoneFilter({
        isDone: query.isDone,
        search,
        proposer: query.proposer,
        startDate: query.startDate,
        endDate: query.endDate,
        sortOrder,
        skip,
        take,
        knownTotal: total,
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
      rows = await nonDoneBaseQb
        .clone()
        .orderBy('archive.noticeNum', sortOrder === 'asc' ? 'ASC' : 'DESC')
        .offset(skip)
        .limit(take)
        .getMany();
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

    await this.applyCurrentOverlayFromDiffchain(rows);

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
    options?: { includeTimeline?: boolean },
  ): Promise<{
    detail: ArchiveDetailResult;
    timeline: Awaited<
      ReturnType<ChangeTrackingService['getNoticeChangeTimeline']>
    >;
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

    const requestedRev = this.parseRevisionQuery(revRaw);
    const includeTimeline = options?.includeTimeline === true;

    if (!includeTimeline && requestedRev === null) {
      const metadata = this.changeTrackingService
        ? await this.changeTrackingService.getNoticeRevisionMetadata(noticeNum)
        : {
            headRev: null,
            hasLegacyGenesisBoundary: false,
            legacyGenesisBoundaryAt: null,
          };

      const resolvedRev = metadata.headRev;

      // Archive rows are immutable, so repairs (proposalReason backfill,
      // source_deleted detection, renumbering, ...) exist only as appended
      // diffchain events. Without this overlay the default detail response
      // would serve the stale snapshot column while list endpoints already
      // show the chain-head value.
      await this.applyCurrentOverlayToDetail(detail);

      return {
        detail,
        timeline: [],
        revision: {
          requestedRev: null,
          resolvedRev,
          headRev: metadata.headRev,
          hasDiffchain: metadata.headRev !== null,
          isHistorical: false,
          hasLegacyGenesisBoundary: metadata.hasLegacyGenesisBoundary,
          legacyGenesisBoundaryAt: metadata.legacyGenesisBoundaryAt,
        },
      };
    }

    const timeline = this.changeTrackingService
      ? await this.changeTrackingService.getCompleteNoticeChangeTimeline(
          noticeNum,
        )
      : [];

    const eventsAsc = [...timeline].sort(
      (a, b) => a.eventHeight - b.eventHeight,
    );
    const headRev =
      eventsAsc.length > 0 ? eventsAsc[eventsAsc.length - 1].eventHeight : null;

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
      timeline,
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

  /**
   * Applies the diffchain head values to a detail payload.
   *
   * The revision-aware path gets chain values from `applyRevisionOverlay`,
   * but the default detail response (no `rev`, no timeline) skips it — this
   * helper gives it the same head overlay the list endpoints apply through
   * `applyCurrentOverlayFromDiffchain`, so a repair that only exists as an
   * appended event (e.g. the proposalReason backfill) is visible to the UI.
   *
   * The response advertises `revision.resolvedRev = headRev`, so the payload
   * must actually carry the head revision's values: after the list-item
   * subset above, every remaining tracked field is read from the chain head
   * and written through `applyTrackedValue` — the same writer
   * `applyRevisionOverlay` uses — so the default response matches
   * `?rev=headRev` instead of silently serving the previous revision.
   *
   * `isDone` is intentionally untouched: it lives in the summary-state table,
   * mirroring the excluded field of the revision-aware path.
   */
  private async applyCurrentOverlayToDetail(
    detail: ArchiveDetailResult,
  ): Promise<void> {
    if (!this.changeTrackingService) {
      return;
    }

    const overlayRow = {
      noticeNum: detail.notice.num,
      subject: detail.notice.subject,
      proposerCategory: detail.notice.proposerCategory,
      committee: detail.notice.committee,
      contentId: detail.notice.contentId,
      proposalReason: detail.originalContent.proposalReason,
      lifecycleStatus: detail.notice.lifecycleStatus,
      sourceDeletedAt: detail.notice.sourceDeletedAt,
    } as unknown as NoticeArchive;

    await this.applyCurrentOverlayFromDiffchain([overlayRow]);

    detail.notice.subject = overlayRow.subject;
    detail.notice.proposerCategory = overlayRow.proposerCategory;
    detail.notice.committee = overlayRow.committee;
    detail.notice.contentId = overlayRow.contentId ?? null;
    detail.notice.lifecycleStatus = overlayRow.lifecycleStatus;
    detail.notice.sourceDeletedAt = overlayRow.sourceDeletedAt ?? null;
    detail.originalContent.contentId =
      overlayRow.contentId ?? detail.originalContent.contentId;
    detail.originalContent.proposalReason = overlayRow.proposalReason ?? '';

    const latestByField =
      await this.changeTrackingService.getLatestFieldValuesForFields(
        [detail.notice.num],
        this.detailChainHeadFieldPaths,
      );
    const fields = latestByField.get(detail.notice.num);
    if (!fields) {
      return;
    }

    for (const fieldPath of this.detailChainHeadFieldPaths) {
      // A field with no diffchain record was never changed by a repair, so
      // the immutable snapshot value stays authoritative for it.
      if (!fields.has(fieldPath)) {
        continue;
      }

      this.applyTrackedValue(detail, fieldPath, fields.get(fieldPath) ?? null);
    }
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
          normalized === NOTICE_LIFECYCLE_STATUS.ACTIVE ||
          normalized === NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED ||
          normalized === NOTICE_LIFECYCLE_STATUS.RENUMBERED
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
    this.changeTrackingService.beginChangeNotificationCollection();
  }

  beginChangeNotificationSuppression(): void {
    this.changeTrackingService.beginChangeNotificationSuppression();
  }

  async endChangeNotificationCollection(): Promise<void> {
    if (!this.changeTrackingService) {
      return;
    }

    await this.changeTrackingService.endChangeNotificationCollection();
  }

  endChangeNotificationSuppression(): void {
    this.changeTrackingService.endChangeNotificationSuppression();
  }

  private async buildChangeTrackingExportData(noticeNum: number): Promise<any> {
    if (!this.changeTrackingService) {
      return null;
    }

    try {
      const events =
        await this.changeTrackingService.getCompleteNoticeChangeTimeline(
          noticeNum,
        );

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
   *
   * Starts at the current Assembly (`BACKFILL_MIN_NOTICE_NUM`): bills from
   * earlier Assemblies are historical rows no source publishes a page for, so
   * a screenshot attempt on them can only fail and log. They are also the
   * lowest notice numbers, which put them at the head of every oldest-first
   * page. See the constant for the production numbers.
   */
  async getNoticesWithMissingScreenshots(
    limit: number,
  ): Promise<Array<{ num: number; contentId: string; isDone: boolean }>> {
    const rows = await this.archiveRepository.find({
      select: { noticeNum: true, contentId: true },
      where: {
        noticeNum: MoreThanOrEqual(
          APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM,
        ),
        screenshotBlob: IsNull(),
        contentId: Not(IsNull()),
        lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
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
      where: {
        contentId: Not(IsNull()),
        lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
      },
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
   *
   * Same Assembly floor as {@link getNoticesWithMissingScreenshots}: older
   * Assemblies have no capturable page, so they only consume captures and
   * produce failure logs.
   */
  async getNoticesWithMissingNsmScreenshots(
    limit: number,
  ): Promise<Array<{ num: number }>> {
    const rows = await this.archiveRepository.find({
      select: { noticeNum: true },
      where: {
        noticeNum: MoreThanOrEqual(
          APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM,
        ),
        screenshotBlob: IsNull(),
        contentId: IsNull(),
        lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
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
    await this.fillMissingSnapshotArtifacts(noticeNum, {
      screenshotBlob: blob,
      screenshotFormat: format,
      screenshotCaptureStatus: 'captured',
    });
  }

  /**
   * Records a permanent screenshot capture failure so the UI can display
   * the reason instead of silently hiding the screenshot button.
   * Only writes when the status column is still NULL (first-fill guard).
   */
  async recordScreenshotCaptureFailure(
    noticeNum: number,
    error: string,
  ): Promise<void> {
    await this.applyGuardedArtifactFill(
      { noticeNum, screenshotCaptureStatus: IsNull() },
      {
        screenshotCaptureStatus: 'failed',
        screenshotCaptureError: error,
      },
      noticeNum,
      'screenshotCaptureFailure',
    );
  }

  /**
   * Records that a row has no verifiable source snapshot yet, keeping it a
   * retry target instead of an invisible gap.
   */
  async seedIntegrityDeficit(
    noticeNum: number,
    skipReason: string = INTEGRITY_SKIP_REASON_MISSING_SOURCE,
  ): Promise<void> {
    try {
      await this.artifactSupport.seedIntegrityDeficit(noticeNum, skipReason);
    } catch (error) {
      this.logger.warn(
        `Failed to seed integrity deficit for notice ${noticeNum}: ${(error as Error).message}`,
      );
    }
  }

  private async applyGuardedArtifactFill(
    criteria: FindOptionsWhere<NoticeArchive>,
    patch: Partial<NoticeArchive>,
    noticeNum: number,
    group: string,
  ): Promise<boolean> {
    try {
      const updateResult = (await this.archiveRepository.update(
        criteria,
        patch,
      )) as { affected?: number | null } | undefined;

      return (updateResult?.affected ?? 0) > 0;
    } catch (error) {
      this.logger.warn(
        `Failed to fill ${group} snapshot artifact for notice ${noticeNum}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Immutability exception: snapshot artifact columns may be filled exactly
   * once while still NULL. Non-null values are never overwritten, and the
   * IS NULL criteria keeps the write race-safe against concurrent fills.
   */
  async fillMissingSnapshotArtifacts(
    noticeNum: number,
    artifacts: {
      sourceHtml?: string | null;
      htmlSha256?: string | null;
      httpMetadata?: ArchiveHttpMetadata | null;
      screenshotBlob?: Buffer | null;
      screenshotFormat?: string | null;
      screenshotCaptureStatus?: string | null;
    },
  ): Promise<SnapshotArtifactFillResult> {
    const result: SnapshotArtifactFillResult = {
      html: false,
      httpMetadata: false,
      screenshot: false,
    };

    const sourceHtml = artifacts.sourceHtml?.trim()
      ? artifacts.sourceHtml
      : null;

    if (sourceHtml) {
      const sha256 = artifacts.htmlSha256?.trim() || computeSha256(sourceHtml);
      result.html = await this.applyGuardedArtifactFill(
        { noticeNum, sourceHtml: IsNull() },
        { sourceHtml, sourceHtmlSha256: sha256 },
        noticeNum,
        'html',
      );
    }

    const httpMetadata = artifacts.httpMetadata ?? null;
    if (httpMetadata) {
      result.httpMetadata = await this.applyGuardedArtifactFill(
        { noticeNum, httpMetadataJson: IsNull() },
        {
          httpMetadataJson: JSON.stringify(httpMetadata),
          httpFetchedAt: parseOptionalDate(httpMetadata.fetchedAt),
          httpStatusCode: httpMetadata.statusCode ?? null,
          httpContentType: httpMetadata.contentType ?? null,
          httpEtag: httpMetadata.etag ?? null,
          httpLastModified: httpMetadata.lastModified ?? null,
        },
        noticeNum,
        'httpMetadata',
      );
    }

    const screenshotBlob = artifacts.screenshotBlob?.length
      ? artifacts.screenshotBlob
      : null;

    if (screenshotBlob) {
      result.screenshot = await this.applyGuardedArtifactFill(
        { noticeNum, screenshotBlob: IsNull() },
        {
          screenshotBlob,
          screenshotFormat: artifacts.screenshotFormat?.trim() || 'jpeg',
          screenshotCaptureStatus:
            artifacts.screenshotCaptureStatus?.trim() || 'captured',
        },
        noticeNum,
        'screenshot',
      );
    }

    if (result.html) {
      try {
        await this.artifactSupport.markIntegrityStatePendingRecheck(noticeNum);
      } catch (error) {
        this.logger.warn(
          `Failed to reset integrity state for notice ${noticeNum}: ${(error as Error).message}`,
        );
      }
    }

    return result;
  }

  /**
   * Returns up to `limit` archived notices whose immutable snapshot is still
   * missing its source HTML, split by source (`pal` = contentId NOT NULL,
   * `nsm` = contentId IS NULL).
   *
   * Newest-first: recent notices are still listed on the source site, so they
   * are the ones a re-capture can actually repair. The scan also starts at the
   * current Assembly (`BACKFILL_MIN_NOTICE_NUM`): an earlier Assembly's rows
   * hold a snapshot no live source can serve again.
   */
  async getNoticesWithMissingSnapshotArtifacts(limit: number): Promise<{
    pal: Array<{ num: number; assemblyLink: string }>;
    nsm: Array<{ num: number }>;
  }> {
    if (limit <= 0) {
      return { pal: [], nsm: [] };
    }

    const [palRows, nsmRows] = await Promise.all([
      this.archiveRepository.find({
        select: { noticeNum: true, assemblyLink: true },
        where: {
          noticeNum: MoreThanOrEqual(
            APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM,
          ),
          sourceHtml: IsNull(),
          contentId: Not(IsNull()),
          lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
        },
        order: { noticeNum: 'DESC' },
        take: limit,
      }),
      this.archiveRepository.find({
        select: { noticeNum: true },
        where: {
          noticeNum: MoreThanOrEqual(
            APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM,
          ),
          sourceHtml: IsNull(),
          contentId: IsNull(),
          lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
        },
        order: { noticeNum: 'DESC' },
        take: limit,
      }),
    ]);

    const latestNsmContentIds =
      await this.changeTrackingService.getLatestFieldValues(
        nsmRows.map((row) => row.noticeNum),
        'contentId',
      );

    return {
      pal: palRows
        .filter((row) => row.assemblyLink?.trim())
        .map((row) => ({
          num: row.noticeNum,
          assemblyLink: row.assemblyLink,
        })),
      nsm: nsmRows
        .filter(
          (row) =>
            !this.normalizeStableId(latestNsmContentIds.get(row.noticeNum)),
        )
        .map((row) => ({ num: row.noticeNum })),
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
    await this.fillMissingSnapshotArtifacts(noticeNum, {
      sourceHtml: html,
      htmlSha256: sha256,
      httpMetadata,
    });
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

    if (this.normalizeStableId(beforeSnapshot.contentId as string | null)) {
      return;
    }

    await this.fillMissingSnapshotArtifacts(noticeNum, {
      sourceHtml: payload.html,
      htmlSha256: payload.sha256,
      httpMetadata: payload.httpMetadata,
      screenshotBlob: payload.screenshotBlob ?? null,
      screenshotFormat: payload.screenshotFormat ?? null,
    });

    const latestProposalReason =
      await this.getLatestProposalReasonForNotice(noticeNum);
    const normalizedLatestProposalReason =
      canonicalizeProposalReason(latestProposalReason);

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
        normalizeTextValue: canonicalizeProposalReason,
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
      eventType: CHANGE_EVENT_TYPE.UPDATED,
      beforeSnapshot,
      afterSnapshot,
      subject: beforeRow.subject,
    });
  }

  /**
   * Appends a proposalReason-only repair event for an archived notice that
   * already carries a pal.assembly.go.kr contentId.
   *
   * `updateNsmHtmlAndDetail` refuses contentId rows by design (its NSM-only
   * guard), so PAL-origin rows recovered from the likms bill database through
   * LikmsCrawler need their own path. Archive rows stay immutable and no
   * snapshot artifact is touched: the recovered reason is appended to the
   * diffchain only, mirroring the NSM repair policy.
   *
   * No-op when the reason is empty or the chain head already holds the same
   * text, so repeated backfill runs never emit duplicate events.
   *
   * @param noticeNum The notice number to repair.
   * @param proposalReason The recovered 제안이유 (already trimmed by the caller).
   */
  async appendLikmsProposalReasonRepair(
    noticeNum: number,
    proposalReason: string,
  ): Promise<void> {
    const resolvedProposalReason = canonicalizeProposalReason(proposalReason);
    if (!resolvedProposalReason) {
      return;
    }

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

    // Chain head wins over the (possibly stale) archive column so a repair
    // appended by a concurrent run is never replayed from a blank baseline.
    const latestProposalReason = canonicalizeProposalReason(
      await this.getLatestProposalReasonForNotice(noticeNum),
    );
    if (latestProposalReason !== null) {
      beforeSnapshot.proposalReason = latestProposalReason;
    }

    const baselineProposalReason =
      typeof beforeSnapshot.proposalReason === 'string'
        ? beforeSnapshot.proposalReason
        : null;
    if (
      canonicalizeProposalReasonForComparison(baselineProposalReason) ===
      canonicalizeProposalReasonForComparison(resolvedProposalReason)
    ) {
      return;
    }

    await this.appendExplicitEventWithDiff({
      noticeNum,
      source: NoticeChangeSource.ARCHIVE_UPDATE_LIKMS_PROPOSAL_REASON,
      eventType: CHANGE_EVENT_TYPE.UPDATED,
      beforeSnapshot,
      afterSnapshot: {
        ...beforeSnapshot,
        proposalReason: resolvedProposalReason,
      },
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
        contentId: true,
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
        contentId: true,
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
      contentId: row.contentId,
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
        ? typeof row.sourceDeletedAt === 'string'
          ? row.sourceDeletedAt
          : row.sourceDeletedAt.toISOString()
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

      const canonicalBeforeSnapshot = canonicalizeChangeSnapshotForSource(
        source,
        2,
        beforeSnapshot,
      );
      const canonicalAfterSnapshot = canonicalizeChangeSnapshotForSource(
        source,
        2,
        afterSnapshot,
      );

      const built = this.changeTrackingService.buildDiffEvent({
        noticeNum,
        beforeSnapshot: canonicalBeforeSnapshot,
        afterSnapshot: canonicalAfterSnapshot ?? afterSnapshot,
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

      await this.resetSummaryStateForProposalReasonChange(
        noticeNum,
        built.eventType,
        built.diff.details.map((detail) => detail.fieldPath),
      );

      const subject =
        typeof afterSnapshot.subject === 'string'
          ? afterSnapshot.subject
          : `notice-${noticeNum}`;

      void this.changeTrackingService
        .dispatchChangeNotification({
          event,
          subject,
          changedFields: built.diff.details.map((detail) => detail.fieldPath),
          changeDetails: built.diff.details.map((detail) => ({
            fieldPath: detail.fieldPath,
            changeType: detail.changeType,
          })),
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

  private async appendIsDoneSyncDiffEvent(
    noticeNum: number,
    beforeRow: TrackedArchiveRow,
    isDone: boolean,
  ): Promise<void> {
    const beforeSnapshot = await this.buildDiffBaselineSnapshot(
      noticeNum,
      beforeRow,
    );
    if (!beforeSnapshot) {
      return;
    }

    await this.appendExplicitEventWithDiff({
      noticeNum,
      source: NoticeChangeSource.ARCHIVE_IS_DONE_SYNC,
      eventType: CHANGE_EVENT_TYPE.UPDATED,
      beforeSnapshot,
      afterSnapshot: {
        ...beforeSnapshot,
        isDone,
      },
      subject: beforeRow.subject,
    });
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

    // Use update-first-then-insert to avoid a TOCTOU race where two
    // concurrent calls both find no existing row and both try to insert,
    // violating the unique index on noticeNum.
    const updateResult = await this.summaryStateRepository.update(
      { noticeNum },
      {
        ...(payload.isDone === undefined ? {} : { isDone: payload.isDone }),
        aiSummary: payload.aiSummary,
        aiSummaryStatus: payload.aiSummaryStatus,
      },
    );

    if ((updateResult.affected ?? 0) === 0) {
      try {
        await this.summaryStateRepository.insert({
          noticeNum,
          isDone: payload.isDone ?? false,
          aiSummary: payload.aiSummary,
          aiSummaryStatus: payload.aiSummaryStatus,
        });
      } catch (error) {
        if (this.isSummaryStateUniqueConflict(error)) {
          // Another concurrent insert won the race — retry the update.
          await this.summaryStateRepository.update(
            { noticeNum },
            {
              ...(payload.isDone === undefined
                ? {}
                : { isDone: payload.isDone }),
              aiSummary: payload.aiSummary,
              aiSummaryStatus: payload.aiSummaryStatus,
            },
          );
          return;
        }
        throw error;
      }
    }
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
      const timeline =
        await this.changeTrackingService.getCompleteNoticeChangeTimeline(
          noticeNum,
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

    await this.resetSummaryStateForProposalReasonChange(
      input.noticeNum,
      built.eventType,
      built.diff.details.map((detail) => detail.fieldPath),
    );

    void this.changeTrackingService
      .dispatchChangeNotification({
        event,
        subject: input.subject,
        changedFields: built.diff.details.map((detail) => detail.fieldPath),
        changeDetails: built.diff.details.map((detail) => ({
          fieldPath: detail.fieldPath,
          changeType: detail.changeType,
        })),
      })
      .catch((dispatchError) => {
        this.logger.warn(
          `Failed to dispatch explicit ${input.eventType} notification for notice ${input.noticeNum}: ${(dispatchError as Error).message}`,
        );
      });
  }

  private async resetSummaryStateForProposalReasonChange(
    noticeNum: number,
    eventType: ChangeEventType,
    changedFields: string[],
  ): Promise<void> {
    if (
      !this.summaryStateRepository ||
      eventType !== CHANGE_EVENT_TYPE.UPDATED ||
      !changedFields.includes('proposalReason')
    ) {
      return;
    }

    try {
      await this.persistSummaryState(noticeNum, {
        aiSummary: null,
        aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to reset AI summary state after proposalReason change for notice ${noticeNum}: ${(error as Error).message}`,
      );
    }
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
   * Returns a map of noticeNum -> stored proposal date (`contentProposalDate`)
   * for rows that have one. Used by the proposalReason retry notification
   * gate to tell long-proposed bills apart from genuinely new ones: a bill
   * the archive discovered only yesterday can still have been proposed
   * months ago, in which case a recovery ping is noise.
   */
  async getContentProposalDateByNoticeNums(
    noticeNums: number[],
  ): Promise<Map<number, string>> {
    const uniqueNums = Array.from(new Set(noticeNums));
    if (uniqueNums.length === 0) {
      return new Map();
    }

    const rows = await this.archiveRepository.find({
      where: { noticeNum: In(uniqueNums) },
      select: { noticeNum: true, contentProposalDate: true },
    });

    const map = new Map<number, string>();
    for (const row of rows) {
      const proposalDate = row.contentProposalDate?.trim();
      if (proposalDate) {
        map.set(row.noticeNum, proposalDate);
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
      // lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE keeps already-source_deleted/renumbered
      // rows out of the recompare candidate pool, so a confirmed-deleted
      // bill isn't re-captured (and re-logged) on every cron cycle.
      where: {
        noticeNum: In(uniqueNums),
        contentId: IsNull(),
        lifecycleStatus: NOTICE_LIFECYCLE_STATUS.ACTIVE,
      },
      select: { noticeNum: true },
    });

    const nullContentIdNums = new Set(rows.map((row) => row.noticeNum));

    if (nullContentIdNums.size === 0 || !this.changeTrackingService) {
      return nullContentIdNums;
    }

    try {
      const latestContentIds =
        await this.changeTrackingService.getLatestFieldValues(
          Array.from(nullContentIdNums),
          'contentId',
        );

      for (const noticeNum of Array.from(nullContentIdNums)) {
        const latestContentId = latestContentIds.get(noticeNum)?.trim();
        if (latestContentId) {
          // Diffchain already knows this notice is PAL-enriched.
          // Treat it as non-NSM for recompare/upgrade routing.
          nullContentIdNums.delete(noticeNum);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Failed to resolve latest contentId from change chain for NSM eligibility filter: ${(error as Error).message}`,
      );
    }

    return nullContentIdNums;
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
          if (lifecycle === NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED) {
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
   * Returns archived notices that still have an empty proposalReason,
   * covering both PAL rows (contentId present, recovered via LikmsCrawler)
   * and contentId-less NSM rows (recovered via NsmLmSts detail capture).
   * Includes ended notice periods and preserves their persisted isDone state.
   * Used by proposalReason backfill cron to periodically re-seed retry queue
   * even when no newly discovered pending bills arrive.
   */
  async getProposalReasonRetryCandidates(limit: number): Promise<
    Array<{
      notice: CachedNotice;
      billNo: string | null;
    }>
  > {
    return getProposalReasonRetryCandidates(this.getMaintenanceDeps(), limit);
  }

  /**
   * Records which notices the proposalReason retry actually attempted, so the
   * next candidate page moves past them instead of re-seeding the same head
   * forever. See {@link getProposalReasonRetryCandidates} for the ordering the
   * stamps drive, and
   * `agent_memories/39-likms-reason-backfill-throughput/` for the production
   * wedge this closes.
   *
   * @returns Number of rows whose attempt stamp advanced
   */
  async recordProposalReasonAttempts(
    noticeNums: Iterable<number>,
    attemptedAt: Date = new Date(),
  ): Promise<number> {
    return recordProposalReasonAttempts(
      this.getMaintenanceDeps(),
      noticeNums,
      attemptedAt,
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
    const notices = await getRecentNoticesForCache(
      this.getMaintenanceDeps(),
      limit,
    );
    await this.applyCurrentOverlayFromDiffchain(notices);
    return notices;
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

  async updateSummaryStatesByNoticeNums(
    updates: SummaryStateBulkUpdateInput[],
    stats?: SummaryStateWriteStats,
  ): Promise<Set<number>> {
    return updateSummaryStatesByNoticeNums(
      this.getMaintenanceDeps(),
      updates,
      stats,
    );
  }
}
