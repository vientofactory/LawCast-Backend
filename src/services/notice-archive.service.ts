import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import {
  Between,
  FindOptionsWhere,
  FindOperator,
  ILike,
  In,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { type AISummaryStatus, type CachedNotice } from '../types/cache.types';
import { NoticeArchive } from '../entities/notice-archive.entity';
import { buildArchiveExportArtifacts } from './archive-export.builder';

export interface ArchiveListQuery {
  page: number;
  limit: number;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  sortOrder?: 'asc' | 'desc';
}

export interface ArchiveOffsetQuery {
  skip: number;
  take: number;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  sortOrder?: 'asc' | 'desc';
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
  aiSummary: string | null;
  aiSummaryStatus: AISummaryStatus;
  attachments: {
    pdfFile: string;
    hwpFile: string;
  };
  archiveStartedAt: Date;
  lastUpdatedAt: Date;
}

export interface ArchiveDetailResult {
  notice: ArchiveNoticeItem;
  originalContent: {
    contentId: string;
    title: string;
    proposalReason: string;
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

@Injectable()
export class NoticeArchiveService {
  constructor(
    @InjectRepository(NoticeArchive)
    private readonly archiveRepository: Repository<NoticeArchive>,
  ) {}

  async upsertNoticeArchive(
    notice: CachedNotice,
    originalContent: {
      proposalReason: string;
      title?: string | null;
      sourceHtml?: string | null;
      htmlSha256?: string | null;
      archivedAt?: Date;
      httpMetadata?: ArchiveHttpMetadata | null;
    },
  ): Promise<void> {
    const normalizedHttpMetadata = originalContent.httpMetadata || null;

    const entity = this.archiveRepository.create({
      noticeNum: notice.num,
      subject: notice.subject,
      proposerCategory: notice.proposerCategory,
      committee: notice.committee,
      assemblyLink: notice.link,
      contentId: notice.contentId ?? null,
      proposalReason: originalContent.proposalReason ?? '',
      sourceTitle: originalContent.title?.trim() || notice.subject,
      aiSummary: notice.aiSummary ?? null,
      aiSummaryStatus: notice.aiSummaryStatus ?? 'not_requested',
      attachmentPdfFile: notice.attachments?.pdfFile ?? '',
      attachmentHwpFile: notice.attachments?.hwpFile ?? '',
      archivedAt: originalContent.archivedAt ?? new Date(),
      sourceHtml: originalContent.sourceHtml ?? null,
      sourceHtmlSha256: originalContent.htmlSha256 ?? null,
      httpMetadataJson: normalizedHttpMetadata
        ? JSON.stringify(normalizedHttpMetadata)
        : null,
      httpFetchedAt: this.parseOptionalDate(normalizedHttpMetadata?.fetchedAt),
      httpStatusCode: normalizedHttpMetadata?.statusCode ?? null,
      httpContentType: normalizedHttpMetadata?.contentType ?? null,
      httpEtag: normalizedHttpMetadata?.etag ?? null,
      httpLastModified: normalizedHttpMetadata?.lastModified ?? null,
    });

    await this.archiveRepository.upsert(entity, ['noticeNum']);
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
    const where = this.buildArchiveWhereConditions({
      search,
      startDate: query.startDate,
      endDate: query.endDate,
    });
    const sortOrder = this.normalizeSortOrder(query.sortOrder);

    const [rows, total] = await this.archiveRepository.findAndCount({
      where,
      order: {
        archiveStartedAt: sortOrder === 'asc' ? 'ASC' : 'DESC',
        noticeNum: sortOrder === 'asc' ? 'ASC' : 'DESC',
      },
      skip,
      take: limit,
    });

    return {
      items: rows.map((row) => this.mapArchiveEntityToNoticeItem(row)),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      search,
    };
  }

  async listArchiveNotices(search?: string): Promise<ArchiveNoticeItem[]> {
    const normalizedSearch = (search || '').trim();
    const where = this.buildArchiveWhereConditions({
      search: normalizedSearch,
    });

    const rows = await this.archiveRepository.find({
      where,
      order: {
        archiveStartedAt: 'DESC',
        noticeNum: 'DESC',
      },
    });

    return rows.map((row) => this.mapArchiveEntityToNoticeItem(row));
  }

  async getArchiveNoticesByOffset(query: ArchiveOffsetQuery): Promise<{
    items: ArchiveNoticeItem[];
    total: number;
    search: string;
  }> {
    const skip = Math.max(0, query.skip || 0);
    const take = Math.max(0, query.take || 0);
    const search = (query.search || '').trim();
    const where = this.buildArchiveWhereConditions({
      search,
      startDate: query.startDate,
      endDate: query.endDate,
    });
    const sortOrder = this.normalizeSortOrder(query.sortOrder);

    const total = await this.archiveRepository.count({ where });

    if (take === 0) {
      return {
        items: [],
        total,
        search,
      };
    }

    const rows = await this.archiveRepository.find({
      where,
      order: {
        archiveStartedAt: sortOrder === 'asc' ? 'ASC' : 'DESC',
        noticeNum: sortOrder === 'asc' ? 'ASC' : 'DESC',
      },
      skip,
      take,
    });

    return {
      items: rows.map((row) => this.mapArchiveEntityToNoticeItem(row)),
      total,
      search,
    };
  }

  async getArchivedNoticeDetail(
    noticeNum: number,
  ): Promise<ArchiveDetailResult | null> {
    const row = await this.archiveRepository.findOne({
      where: { noticeNum },
    });

    if (!row) {
      return null;
    }

    const integrity = await this.verifyAndRefreshIntegrity(row);
    const httpMetadata = this.parseHttpMetadata(row.httpMetadataJson);

    return {
      notice: this.mapArchiveEntityToNoticeItem(row),
      originalContent: {
        contentId: row.contentId ?? '',
        title: row.sourceTitle?.trim() || row.subject,
        proposalReason: row.proposalReason || '',
      },
      archiveMetadata: {
        archivedAt: row.archivedAt,
        sourceHtmlSha256: row.sourceHtmlSha256,
        sourceHtmlSize: row.sourceHtml
          ? Buffer.byteLength(row.sourceHtml, 'utf8')
          : 0,
        integrity: {
          checkedAt: integrity.checkedAt,
          passed: integrity.passed,
          calculatedSha256: integrity.calculatedSha256,
        },
        http: {
          fetchedAt: row.httpFetchedAt,
          statusCode: row.httpStatusCode,
          contentType: row.httpContentType,
          etag: row.httpEtag,
          lastModified: row.httpLastModified,
          requestUrl:
            typeof httpMetadata.requestUrl === 'string'
              ? httpMetadata.requestUrl
              : undefined,
          responseUrl:
            typeof httpMetadata.responseUrl === 'string'
              ? httpMetadata.responseUrl
              : undefined,
        },
      },
    };
  }

  async buildArchiveExportFile(
    noticeNum: number,
  ): Promise<ArchiveExportResult | null> {
    const row = await this.archiveRepository.findOne({
      where: { noticeNum },
    });

    if (!row) {
      return null;
    }

    const integrity = await this.verifyAndRefreshIntegrity(row);
    const httpMetadata = this.parseHttpMetadata(row.httpMetadataJson);
    const generatedAt = new Date();

    return buildArchiveExportArtifacts({
      noticeNum,
      generatedAt,
      row,
      integrity,
      httpMetadata,
      dbRecord: this.mapArchiveEntityToRawRecord(row),
    });
  }

  async existsByNoticeNum(noticeNum: number): Promise<boolean> {
    return this.archiveRepository.exists({ where: { noticeNum } });
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

  async getArchiveCount(): Promise<number> {
    return this.archiveRepository.count();
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
    const where = this.buildArchiveWhereConditions({
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

  private mapArchiveEntityToNoticeItem(row: NoticeArchive): ArchiveNoticeItem {
    return {
      num: row.noticeNum,
      subject: row.subject,
      proposerCategory: row.proposerCategory,
      committee: row.committee,
      link: row.assemblyLink,
      contentId: row.contentId,
      aiSummary: row.aiSummary,
      aiSummaryStatus: (row.aiSummaryStatus ||
        'not_requested') as AISummaryStatus,
      attachments: {
        pdfFile: row.attachmentPdfFile,
        hwpFile: row.attachmentHwpFile,
      },
      archiveStartedAt: row.archiveStartedAt,
      lastUpdatedAt: row.lastUpdatedAt,
    };
  }

  private mapArchiveEntityToRawRecord(row: NoticeArchive) {
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

  private normalizeSortOrder(sortOrder?: 'asc' | 'desc'): 'asc' | 'desc' {
    return sortOrder === 'asc' ? 'asc' : 'desc';
  }

  private buildArchiveWhereConditions(params: {
    search?: string;
    startDate?: Date;
    endDate?: Date;
    noticeNumCondition?: FindOperator<number>;
  }):
    | FindOptionsWhere<NoticeArchive>
    | FindOptionsWhere<NoticeArchive>[]
    | undefined {
    const normalizedSearch = (params.search || '').trim();
    const baseWhere: FindOptionsWhere<NoticeArchive> = {};

    if (params.noticeNumCondition) {
      baseWhere.noticeNum = params.noticeNumCondition;
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

    return [
      { ...baseWhere, subject: ILike(`%${normalizedSearch}%`) },
      { ...baseWhere, proposalReason: ILike(`%${normalizedSearch}%`) },
      { ...baseWhere, committee: ILike(`%${normalizedSearch}%`) },
    ];
  }

  private parseHttpMetadata(raw: string | null): ArchiveHttpMetadata {
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

  private parseOptionalDate(value?: string): Date | null {
    if (!value) {
      return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private computeSha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  private async verifyAndRefreshIntegrity(row: NoticeArchive): Promise<{
    checkedAt: Date | null;
    passed: boolean | null;
    calculatedSha256: string | null;
  }> {
    if (!row.sourceHtml || !row.sourceHtmlSha256) {
      return {
        checkedAt: row.integrityVerifiedAt ?? null,
        passed: row.integrityCheckPassed ?? null,
        calculatedSha256: null,
      };
    }

    const calculatedSha256 = this.computeSha256(row.sourceHtml);
    const passed = calculatedSha256 === row.sourceHtmlSha256;
    const checkedAt = new Date();

    if (row.integrityCheckPassed !== passed || !row.integrityVerifiedAt) {
      await this.archiveRepository.update(
        { id: row.id },
        {
          integrityCheckPassed: passed,
          integrityVerifiedAt: checkedAt,
        },
      );

      row.integrityCheckPassed = passed;
      row.integrityVerifiedAt = checkedAt;
    }

    return {
      checkedAt: row.integrityVerifiedAt,
      passed,
      calculatedSha256,
    };
  }
}
