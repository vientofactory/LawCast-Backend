import { In, LessThan, MoreThan, type Repository } from 'typeorm';
import {
  type AISummaryStatus,
  type CachedNotice,
} from '../../../types/cache.types';
import {
  NoticeArchive,
  NOTICE_LIFECYCLE_STATUS,
} from '../notice-archive.entity';
import { NoticeArchiveSnapshotState } from '../notice-archive-summary-state.entity';
import {
  buildArchiveWhereConditions,
  mapArchiveEntityToCachedNotice,
} from '../notice-archive.helpers';
import { type ChangeTrackingService } from '../../change-tracking/change-tracking.service';
import { type NoticeArchiveArtifactSupport } from './notice-archive-artifact-support';
import {
  type ArchiveNumCompareCountQuery,
  type ArchiveSummaryState,
} from '../notice-archive.service';
import { AI_SUMMARY_STATUS } from '../../../modules/crawling/utils/ai-summary-status.utils';
import { APP_CONSTANTS } from '../../../config/app.config';

export interface NoticeArchiveMaintenanceDeps {
  archiveRepository: Repository<NoticeArchive>;
  summaryStateRepository?: Repository<NoticeArchiveSnapshotState>;
  changeTrackingService: ChangeTrackingService;
  artifactSupport: NoticeArchiveArtifactSupport;
  logger: { warn(message: string): void };
}

export interface SummaryStateBulkUpdateInput {
  noticeNum: number;
  summary: string | null;
  status: AISummaryStatus;
}

/**
 * Write counters for a summary-state bulk write. `skipped` counts the rows
 * whose persisted verdict already matched the one the caller produced, so no
 * statement ran for them at all; `changedNoticeNums` names the rows that did
 * get a new verdict, for callers that mirror the verdict somewhere else (the
 * recent-notices cache) and can leave the untouched rows alone.
 */
export interface SummaryStateWriteStats {
  changed: number;
  skipped: number;
  changedNoticeNums: Set<number>;
}

/**
 * Returns archived notices that still have an empty proposalReason, covering
 * both origins: PAL rows (contentId present) are recovered from the likms
 * bill database via LikmsCrawler, contentId-less NSM rows fall back to the
 * NsmLmSts detail capture.
 *
 * Includes ended notice periods and preserves their persisted isDone state.
 * Used by the proposalReason backfill cron to periodically re-seed the retry
 * queue even when no newly discovered pending bills arrive.
 *
 * **Ordering is attempt history, not notice number.** Page order is
 * `proposal_reason_retry_count ASC` (never attempted first, so every newly
 * arrived candidate is served before a row that already failed),
 * `proposal_reason_retried_at ASC` (oldest attempt first, so rows with equal
 * counts rotate instead of one fixed head being re-seeded), then `noticeNum ASC`
 * for a stable page. The previous plain `noticeNum ASC` page had no memory of
 * earlier attempts, so the lowest notice numbers - in production, non-bill
 * agenda items (`사직의건`/`결의안`) whose reason exists in no source - were
 * re-seeded on every tick and, once dropped by the drain for returning nothing,
 * re-selected again: the 180 rows with a recoverable reason behind them were
 * never reached
 * (agent_memories/39-likms-reason-backfill-throughput/).
 *
 * **Scope is the current Assembly or later.** Rows below
 * `ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM` belong to an earlier Assembly (the
 * archive keeps historical bills whose sources publish no detail page), so an
 * attempt on them can only ever return nothing and log a warning. At 20 rows a
 * tick they also consumed the whole candidate page. See the constant for the
 * production numbers.
 */
export async function getProposalReasonRetryCandidates(
  deps: NoticeArchiveMaintenanceDeps,
  limit: number,
): Promise<
  Array<{
    notice: CachedNotice;
    billNo: string | null;
  }>
> {
  // Notice-period completion does not prevent NSM detail recovery.
  // Keep lifecycle eligibility separate from the persisted isDone state.
  const rows = await deps.archiveRepository
    .createQueryBuilder('na')
    .select([
      'na.noticeNum AS noticeNum',
      'na.subject AS subject',
      'na.proposerCategory AS proposerCategory',
      'na.committee AS committee',
      'na.assemblyLink AS assemblyLink',
      'na.contentId AS contentId',
      'na.content_bill_number AS contentBillNumber',
      'na.attachmentPdfFile AS attachmentPdfFile',
      'na.attachmentHwpFile AS attachmentHwpFile',
    ])
    .where('na.lifecycle_status = :status', {
      status: NOTICE_LIFECYCLE_STATUS.ACTIVE,
    })
    .andWhere('na.noticeNum >= :minNoticeNum', {
      minNoticeNum: APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM,
    })
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
    .andWhere(
      `NOT EXISTS (
          SELECT 1
          FROM notice_change_events e
          INNER JOIN notice_change_details d ON d.event_id = e.id
          WHERE e.notice_num = na.noticeNum
            AND d.field_path = :lifecycleStatusFieldPath
            AND d.after_value = :sourceDeletedLifecycle
        )`,
      {
        lifecycleStatusFieldPath: 'lifecycleStatus',
        sourceDeletedLifecycle: 'source_deleted',
      },
    )
    .orderBy('na.proposalReasonRetryCount', 'ASC')
    .addOrderBy('na.proposalReasonRetriedAt', 'ASC')
    .addOrderBy('na.noticeNum', 'ASC')
    .limit(limit)
    .getRawMany<{
      noticeNum: number;
      subject: string;
      proposerCategory: string;
      committee: string;
      assemblyLink: string;
      contentId: string | null;
      contentBillNumber: string | null;
      attachmentPdfFile: string | null;
      attachmentHwpFile: string | null;
    }>();

  const summaryStates = await getSummaryStateByNoticeNums(
    deps,
    rows.map((row) => row.noticeNum),
  );

  return rows.map((row) => ({
    notice: {
      num: row.noticeNum,
      subject: row.subject,
      proposerCategory: row.proposerCategory,
      committee: row.committee,
      link: row.assemblyLink,
      contentId: row.contentId,
      isDone: summaryStates.get(row.noticeNum)?.isDone ?? false,
      proposalReason: null,
      attachments: {
        pdfFile: row.attachmentPdfFile ?? '',
        hwpFile: row.attachmentHwpFile ?? '',
      },
      aiSummary: null,
      aiSummaryStatus: AI_SUMMARY_STATUS.NOT_SUPPORTED,
    },
    billNo: row.contentBillNumber?.trim() || null,
  }));
}

export async function getArchiveCount(
  deps: NoticeArchiveMaintenanceDeps,
): Promise<number> {
  return deps.archiveRepository.count();
}

/**
 * Bound notices per `notice_archives` UPDATE when stamping retry attempts.
 * Matches the list-sighting stamp so every statement stays far below SQLite's
 * bound-parameter ceiling.
 */
const PROPOSAL_REASON_ATTEMPT_STAMP_CHUNK_SIZE = 400;

/**
 * Records that the proposalReason retry attempted to recover the reason of
each given notice, by advancing its attempt count and timestamp.
 *
 * This is what makes the candidate cursor advance: without it the next
 * candidate page is the same `noticeNum ASC` head it was before, which in
 * production meant the same 20 unrecoverable rows were re-seeded every 15
 * minutes and the recoverable rows behind them were never reached.
 *
 * Only the two tracking columns change, so the archive immutability trigger
 * stays satisfied (they are outside its unchanged-column list, like the
 * list-sighting stamps). A failure here is logged and swallowed by the caller's
 * contract: losing one attempt stamp costs a repeated attempt, and must never
 * abort a drain that may have already archived and summarized other rows.
 *
 * @returns Number of rows whose attempt stamp was advanced
 */
export async function recordProposalReasonAttempts(
  deps: NoticeArchiveMaintenanceDeps,
  noticeNums: Iterable<number>,
  attemptedAt: Date,
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
    offset += PROPOSAL_REASON_ATTEMPT_STAMP_CHUNK_SIZE
  ) {
    const chunk = uniqueNums.slice(
      offset,
      offset + PROPOSAL_REASON_ATTEMPT_STAMP_CHUNK_SIZE,
    );

    const result = await deps.archiveRepository
      .createQueryBuilder()
      .update(NoticeArchive)
      .set({
        // Expression value: increments in the database, so two overlapping
        // passages cannot overwrite each other's count with a stale read.
        proposalReasonRetryCount: () => '"proposal_reason_retry_count" + 1',
        proposalReasonRetriedAt: attemptedAt,
      })
      .where('"noticeNum" IN (:...noticeNums)', { noticeNums: chunk })
      .execute();

    stampedCount += result?.affected ?? 0;
  }

  return stampedCount;
}

export async function getRecentNoticesForCache(
  deps: NoticeArchiveMaintenanceDeps,
  limit: number,
): Promise<CachedNotice[]> {
  if (!deps.summaryStateRepository) {
    return [];
  }

  const activeRows = await deps.archiveRepository
    .createQueryBuilder('archive')
    .innerJoin(
      NoticeArchiveSnapshotState,
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
    ])
    .where('summary.is_done = :isDone', { isDone: 0 })
    .orderBy('archive.noticeNum', 'DESC')
    .take(limit)
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
    }>();

  const rows = activeRows.map((row) =>
    deps.archiveRepository.create({
      noticeNum: Number(row.noticeNum),
      subject: row.subject,
      proposerCategory: row.proposerCategory,
      committee: row.committee,
      assemblyLink: row.assemblyLink,
      contentId: row.contentId,
      proposalReason: row.proposalReason ?? '',
      attachmentPdfFile: row.attachmentPdfFile ?? '',
      attachmentHwpFile: row.attachmentHwpFile ?? '',
    }),
  );

  if (deps.summaryStateRepository && rows.length > 0) {
    const summaryStates = await getSummaryStateByNoticeNums(
      deps,
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

  return rows.map((row) =>
    mapArchiveEntityToCachedNotice(row, 'not_requested'),
  );
}

export async function getLatestProposalReason(
  deps: NoticeArchiveMaintenanceDeps,
  noticeNum: number,
): Promise<string | null> {
  try {
    return deps.changeTrackingService.getLatestFieldValue(
      noticeNum,
      'proposalReason',
    );
  } catch (error) {
    deps.logger.warn(
      `Failed to load latest proposalReason from change chain for notice ${noticeNum}: ${(error as Error).message}`,
    );
    return null;
  }
}

export async function runIntegrityScan(
  deps: NoticeArchiveMaintenanceDeps,
  batchSize = 200,
): Promise<{
  scanned: number;
  passed: number;
  failed: number;
  skipped: number;
}> {
  return deps.artifactSupport.runIntegrityScan(batchSize);
}

export async function getArchiveStartedAtByNoticeNums(
  deps: NoticeArchiveMaintenanceDeps,
  noticeNums: number[],
): Promise<Map<number, Date>> {
  const uniqueNums = Array.from(new Set(noticeNums));

  if (uniqueNums.length === 0) {
    return new Map();
  }

  const rows: Array<{ noticeNum: unknown; archiveStartedAt: unknown }> = [];
  const batchSize = 500;
  for (let offset = 0; offset < uniqueNums.length; offset += batchSize) {
    const batch = uniqueNums.slice(offset, offset + batchSize);
    const placeholders = batch.map(() => '?').join(', ');
    const batchRows = await deps.archiveRepository.manager.query(
      `SELECT "noticeNum" AS "noticeNum",
              "archive_started_at" AS "archiveStartedAt"
       FROM "notice_archives"
       INDEXED BY "idx_notice_archives_notice_num_archive_started_at"
       WHERE "noticeNum" IN (${placeholders})`,
      batch,
    );
    rows.push(...batchRows);
  }

  const result = new Map<number, Date>();
  for (const row of rows) {
    const noticeNum = Number(row.noticeNum);
    const archiveStartedAt = new Date(String(row.archiveStartedAt));
    if (
      Number.isInteger(noticeNum) &&
      !Number.isNaN(archiveStartedAt.getTime())
    ) {
      result.set(noticeNum, archiveStartedAt);
    }
  }
  return result;
}

export async function countByNoticeNumComparison(
  deps: NoticeArchiveMaintenanceDeps,
  query: ArchiveNumCompareCountQuery,
): Promise<number> {
  const where = buildArchiveWhereConditions({
    search: query.search,
    proposer: query.proposer,
    startDate: query.startDate,
    endDate: query.endDate,
    noticeNumCondition:
      query.operator === 'gt' ? MoreThan(query.num) : LessThan(query.num),
  });

  return deps.archiveRepository.count({ where });
}

export async function getSummaryStateByNoticeNums(
  deps: NoticeArchiveMaintenanceDeps,
  noticeNums: number[],
): Promise<Map<number, ArchiveSummaryState>> {
  const uniqueNums = Array.from(new Set(noticeNums));

  if (uniqueNums.length === 0) {
    return new Map();
  }

  if (!deps.summaryStateRepository) {
    return new Map();
  }

  const rows = await deps.summaryStateRepository.find({
    where: { noticeNum: In(uniqueNums) },
    select: {
      noticeNum: true,
      isDone: true,
      aiSummary: true,
      aiSummaryStatus: true,
    },
  });

  return new Map<number, ArchiveSummaryState>(
    rows.map((row): [number, ArchiveSummaryState] => [
      row.noticeNum,
      {
        isDone: row.isDone ?? false,
        aiSummary: row.aiSummary ?? null,
        aiSummaryStatus: (row.aiSummaryStatus ||
          'not_requested') as AISummaryStatus,
      },
    ]),
  );
}

/**
 * Whether the persisted state already carries this exact verdict. Only
 * `aiSummary` and `aiSummaryStatus` are compared because those are the columns
 * the bulk upsert's conflict branch writes - `isDone` is insert-only there, so
 * a state that differs only in `isDone` is not a change for this purpose.
 */
function isSameSummaryVerdict(
  existing: ArchiveSummaryState | undefined,
  candidate: { aiSummary: string | null; aiSummaryStatus: string },
): boolean {
  return (
    existing !== undefined &&
    (existing.aiSummary ?? null) === candidate.aiSummary &&
    existing.aiSummaryStatus === candidate.aiSummaryStatus
  );
}

export async function updateSummaryStateByNoticeNum(
  deps: NoticeArchiveMaintenanceDeps,
  noticeNum: number,
  summary: string | null,
  status: AISummaryStatus,
): Promise<void> {
  const normalizedSummary = summary?.trim() ? summary : null;

  if (!deps.summaryStateRepository) {
    return;
  }

  // A caller that re-derives the verdict a row already carries - the backfill's
  // unrecoverable rows, a proposal retry that still finds no reason - must not
  // rewrite the row: the write changes nothing but the row image and the WAL.
  const currentStates = await getSummaryStateByNoticeNums(deps, [noticeNum]);
  if (
    isSameSummaryVerdict(currentStates.get(noticeNum), {
      aiSummary: normalizedSummary,
      aiSummaryStatus: status,
    })
  ) {
    return;
  }

  const updateResult = await deps.summaryStateRepository.update(
    { noticeNum },
    {
      aiSummary: normalizedSummary,
      aiSummaryStatus: status,
    },
  );

  if ((updateResult.affected ?? 0) === 0) {
    try {
      await deps.summaryStateRepository.insert({
        noticeNum,
        isDone: false,
        aiSummary: normalizedSummary,
        aiSummaryStatus: status,
      });
    } catch {
      await deps.summaryStateRepository.update(
        { noticeNum },
        {
          aiSummary: normalizedSummary,
          aiSummaryStatus: status,
        },
      );
    }
  }
}

export async function updateSummaryStatesByNoticeNums(
  deps: NoticeArchiveMaintenanceDeps,
  updates: SummaryStateBulkUpdateInput[],
  stats?: SummaryStateWriteStats,
): Promise<Set<number>> {
  if (!deps.summaryStateRepository || updates.length === 0) {
    return new Set();
  }

  const deduped = new Map<number, SummaryStateBulkUpdateInput>();
  for (const update of updates) {
    deduped.set(update.noticeNum, update);
  }

  const values = Array.from(deduped.values()).map((update) => ({
    noticeNum: update.noticeNum,
    isDone: false,
    aiSummary: update.summary?.trim() ? update.summary : null,
    aiSummaryStatus: update.status,
  }));

  // The summary backfill re-derives the same verdict for every row it cannot
  // summarize - `not_supported` with no reason anywhere - on every pass, which
  // meant rewriting the same ~315 rows every 15 minutes to store what they
  // already held. Rows whose persisted verdict already matches are dropped
  // before the statement is built, so no row image and no WAL frame is
  // produced for them.
  //
  // Consequence for operators: `updated_at` now marks the last verdict
  // *change*, not the last pass. A pass's scope comes from its staged count and
  // the apply log's `unchanged=` counter (see `SummaryStateWriteStats`).
  const currentStates = await getSummaryStateByNoticeNums(
    deps,
    values.map((value) => value.noticeNum),
  );
  const pendingValues = values.filter(
    (value) => !isSameSummaryVerdict(currentStates.get(value.noticeNum), value),
  );

  if (stats) {
    stats.changed += pendingValues.length;
    stats.skipped += values.length - pendingValues.length;
    for (const value of pendingValues) {
      stats.changedNoticeNums.add(value.noticeNum);
    }
  }

  // Every requested verdict is already stored, so the caller's confirmed set is
  // complete without touching the table.
  if (pendingValues.length === 0) {
    return new Set(values.map((value) => value.noticeNum));
  }

  const pendingNoticeNums = new Set(
    pendingValues.map((value) => value.noticeNum),
  );

  try {
    await deps.summaryStateRepository
      .createQueryBuilder()
      .insert()
      .into(NoticeArchiveSnapshotState)
      .values(pendingValues)
      // Avoid entity-return mapping on SQLite upsert path where id may not be returned.
      .updateEntity(false)
      // Use physical DB column names for SQLite ON CONFLICT compatibility.
      // `updated_at` is listed explicitly: TypeORM only emits
      // `updated_at = DEFAULT` for the conflicting row on drivers outside the
      // SQLite family, so without this the backfill's bulk write left the
      // column at its insert-time value and a processed row was
      // indistinguishable from an untouched one. It is only reached for the
      // rows that do carry a new verdict, since unchanged ones were filtered
      // out above.
      .orUpdate(
        ['ai_summary', 'ai_summary_status', 'updated_at'],
        ['notice_num'],
      )
      .execute();

    return new Set(values.map((value) => value.noticeNum));
  } catch (error) {
    deps.logger.warn(
      `Bulk summary-state upsert failed, falling back to per-row update: ${(error as Error).message}`,
    );

    const persistedNoticeNums = new Set<number>();
    for (const update of deduped.values()) {
      if (!pendingNoticeNums.has(update.noticeNum)) {
        // Skipped above because the row already holds this verdict.
        persistedNoticeNums.add(update.noticeNum);
        continue;
      }
      try {
        await updateSummaryStateByNoticeNum(
          deps,
          update.noticeNum,
          update.summary,
          update.status,
        );
        persistedNoticeNums.add(update.noticeNum);
      } catch (itemError) {
        deps.logger.warn(
          `Summary-state fallback update failed for notice ${update.noticeNum}: ${(itemError as Error).message}`,
        );
      }
    }

    return persistedNoticeNums;
  }
}
