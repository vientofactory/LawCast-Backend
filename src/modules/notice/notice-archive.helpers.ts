import { createHash } from 'crypto';
import {
  Between,
  type FindOperator,
  type FindOptionsWhere,
  ILike,
  LessThanOrEqual,
  MoreThanOrEqual,
} from 'typeorm';
import {
  type AISummaryStatus,
  type CachedNotice,
} from '../../types/cache.types';
import { AI_SUMMARY_STATUS } from '../crawling/utils/ai-summary-status.utils';
import { NoticeArchive } from './notice-archive.entity';
import {
  type ArchiveHttpMetadata,
  type ArchiveNoticeItem,
} from './notice-archive.service';

export const NOTICE_ITEM_SELECT = {
  noticeNum: true,
  subject: true,
  proposerCategory: true,
  committee: true,
  assemblyLink: true,
  contentId: true,
  isDone: true,
  aiSummary: true,
  aiSummaryStatus: true,
  attachmentPdfFile: true,
  attachmentHwpFile: true,
  archiveStartedAt: true,
  lastUpdatedAt: true,
} as const;

export function mapArchiveEntityToNoticeItem(
  row: NoticeArchive,
): ArchiveNoticeItem {
  return {
    num: row.noticeNum,
    subject: row.subject,
    proposerCategory: row.proposerCategory,
    committee: row.committee,
    link: row.assemblyLink,
    contentId: row.contentId,
    isDone: row.isDone ?? false,
    aiSummary: row.aiSummary,
    aiSummaryStatus: (row.aiSummaryStatus ||
      AI_SUMMARY_STATUS.NOT_REQUESTED) as AISummaryStatus,
    attachments: {
      pdfFile: row.attachmentPdfFile,
      hwpFile: row.attachmentHwpFile,
    },
    archiveStartedAt: row.archiveStartedAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export function mapArchiveEntityToRawRecord(row: NoticeArchive) {
  return {
    id: row.id,
    noticeNum: row.noticeNum,
    subject: row.subject,
    proposerCategory: row.proposerCategory,
    committee: row.committee,
    assemblyLink: row.assemblyLink,
    contentId: row.contentId,
    proposalReason: row.proposalReason,
    sourceTitle: row.sourceTitle,
    contentBillNumber: row.contentBillNumber,
    contentProposer: row.contentProposer,
    contentProposalDate: row.contentProposalDate,
    contentCommittee: row.contentCommittee,
    contentReferralDate: row.contentReferralDate,
    contentNoticePeriod: row.contentNoticePeriod,
    contentProposalSession: row.contentProposalSession,
    aiSummary: row.aiSummary,
    aiSummaryStatus: row.aiSummaryStatus,
    attachmentPdfFile: row.attachmentPdfFile,
    attachmentHwpFile: row.attachmentHwpFile,
    archivedAt: row.archivedAt,
    sourceHtml: row.sourceHtml,
    sourceHtmlSha256: row.sourceHtmlSha256,
    integrityVerifiedAt: row.integrityVerifiedAt,
    integrityCheckPassed: row.integrityCheckPassed,
    httpMetadataJson: row.httpMetadataJson,
    httpFetchedAt: row.httpFetchedAt,
    httpStatusCode: row.httpStatusCode,
    httpContentType: row.httpContentType,
    httpEtag: row.httpEtag,
    httpLastModified: row.httpLastModified,
    archiveStartedAt: row.archiveStartedAt,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

export function mapArchiveEntityToCachedNotice(
  row: Pick<
    NoticeArchive,
    | 'noticeNum'
    | 'subject'
    | 'proposerCategory'
    | 'committee'
    | 'assemblyLink'
    | 'contentId'
    | 'proposalReason'
    | 'attachmentPdfFile'
    | 'attachmentHwpFile'
    | 'aiSummary'
    | 'aiSummaryStatus'
  >,
  fallbackStatus: AISummaryStatus,
): CachedNotice {
  return {
    num: row.noticeNum,
    subject: row.subject,
    proposerCategory: row.proposerCategory,
    committee: row.committee,
    link: row.assemblyLink,
    contentId: row.contentId,
    proposalReason: row.proposalReason || null,
    attachments: {
      pdfFile: row.attachmentPdfFile ?? '',
      hwpFile: row.attachmentHwpFile ?? '',
    },
    aiSummary: row.aiSummary ?? null,
    aiSummaryStatus: (row.aiSummaryStatus ?? fallbackStatus) as AISummaryStatus,
  };
}

export function normalizeSortOrder(sortOrder?: 'asc' | 'desc'): 'asc' | 'desc' {
  return sortOrder === 'asc' ? 'asc' : 'desc';
}

export function buildArchiveWhereConditions(params: {
  search?: string;
  startDate?: Date;
  endDate?: Date;
  noticeNumCondition?: FindOperator<number>;
  isDone?: boolean;
  fullText?: boolean;
}):
  | FindOptionsWhere<NoticeArchive>
  | FindOptionsWhere<NoticeArchive>[]
  | undefined {
  const normalizedSearch = (params.search || '').trim();
  const baseWhere: FindOptionsWhere<NoticeArchive> = {};

  if (params.noticeNumCondition) {
    baseWhere.noticeNum = params.noticeNumCondition;
  }

  if (params.isDone !== undefined) {
    baseWhere.isDone = params.isDone;
  }

  if (params.startDate && params.endDate) {
    baseWhere.archiveStartedAt =
      params.startDate <= params.endDate
        ? Between(params.startDate, params.endDate)
        : Between(params.endDate, params.startDate);
  } else if (params.startDate) {
    baseWhere.archiveStartedAt = MoreThanOrEqual(params.startDate);
  } else if (params.endDate) {
    baseWhere.archiveStartedAt = LessThanOrEqual(params.endDate);
  }

  if (!normalizedSearch) {
    return Object.keys(baseWhere).length > 0 ? baseWhere : undefined;
  }

  const conditions: FindOptionsWhere<NoticeArchive>[] = [
    { ...baseWhere, subject: ILike(`%${normalizedSearch}%`) },
    { ...baseWhere, committee: ILike(`%${normalizedSearch}%`) },
  ];

  if (params.fullText) {
    conditions.push({
      ...baseWhere,
      proposalReason: ILike(`%${normalizedSearch}%`),
    });
  }

  return conditions;
}

export function parseHttpMetadata(raw: string | null): ArchiveHttpMetadata {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as ArchiveHttpMetadata;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function parseOptionalDate(value?: string): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function computeSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
