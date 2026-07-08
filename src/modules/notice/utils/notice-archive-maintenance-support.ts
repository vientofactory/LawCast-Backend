import { In, LessThan, MoreThan, type Repository } from 'typeorm';
import {
  type AISummaryStatus,
  type CachedNotice,
} from '../../../types/cache.types';
import { NoticeArchive } from '../notice-archive.entity';
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

export interface NoticeArchiveMaintenanceDeps {
  archiveRepository: Repository<NoticeArchive>;
  summaryStateRepository?: Repository<NoticeArchiveSnapshotState>;
  changeTrackingService?: ChangeTrackingService;
  artifactSupport: NoticeArchiveArtifactSupport;
  logger: { warn(message: string): void };
}

export async function getNsmProposalReasonRetryCandidatesInternal(
  deps: NoticeArchiveMaintenanceDeps,
  limit: number,
): Promise<
  Array<{
    notice: CachedNotice;
    billNo: string | null;
  }>
> {
  const rows = await deps.archiveRepository
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
    .andWhere(
      `COALESCE((
          SELECT s.is_done
          FROM notice_archive_snapshot_states s
          WHERE s.notice_num = na.noticeNum
          LIMIT 1
        ), 0) = :isDone`,
      { isDone: 0 },
    )
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

export async function getArchiveCountInternal(
  deps: NoticeArchiveMaintenanceDeps,
): Promise<number> {
  return deps.archiveRepository.count();
}

export async function getRecentNoticesForCacheInternal(
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
    const summaryStates = await getSummaryStateByNoticeNumsInternal(
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

export async function getLatestProposalReasonForNoticeInternal(
  deps: NoticeArchiveMaintenanceDeps,
  noticeNum: number,
): Promise<string | null> {
  if (!deps.changeTrackingService) {
    return null;
  }

  try {
    return deps.changeTrackingService.getLatestFieldAfterValue(
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

export async function runIntegrityScanInternal(
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

export async function getArchiveStartedAtByNoticeNumsInternal(
  deps: NoticeArchiveMaintenanceDeps,
  noticeNums: number[],
): Promise<Map<number, Date>> {
  const uniqueNums = Array.from(new Set(noticeNums));

  if (uniqueNums.length === 0) {
    return new Map();
  }

  const rows = await deps.archiveRepository.find({
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

export async function countByNoticeNumComparisonInternal(
  deps: NoticeArchiveMaintenanceDeps,
  query: ArchiveNumCompareCountQuery,
): Promise<number> {
  const where = buildArchiveWhereConditions({
    search: query.search,
    startDate: query.startDate,
    endDate: query.endDate,
    noticeNumCondition:
      query.operator === 'gt' ? MoreThan(query.num) : LessThan(query.num),
  });

  return deps.archiveRepository.count({ where });
}

export async function getSummaryStateByNoticeNumsInternal(
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

export async function updateSummaryStateByNoticeNumInternal(
  deps: NoticeArchiveMaintenanceDeps,
  noticeNum: number,
  summary: string | null,
  status: AISummaryStatus,
): Promise<void> {
  const normalizedSummary = summary?.trim() ? summary : null;

  if (!deps.summaryStateRepository) {
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
