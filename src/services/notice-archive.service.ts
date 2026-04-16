import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { type AISummaryStatus, type CachedNotice } from '../types/cache.types';
import { NoticeArchive } from '../entities/notice-archive.entity';

export interface ArchiveListQuery {
  page: number;
  limit: number;
  search?: string;
}

export interface ArchiveNoticeItem {
  num: number;
  subject: string;
  proposerCategory: string;
  committee: string;
  numComments: number;
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
    },
  ): Promise<void> {
    const entity = this.archiveRepository.create({
      noticeNum: notice.num,
      subject: notice.subject,
      proposerCategory: notice.proposerCategory,
      committee: notice.committee,
      numComments: notice.numComments,
      assemblyLink: notice.link,
      contentId: notice.contentId ?? null,
      proposalReason: originalContent.proposalReason ?? '',
      sourceTitle: originalContent.title?.trim() || notice.subject,
      aiSummary: notice.aiSummary ?? null,
      aiSummaryStatus: notice.aiSummaryStatus ?? 'not_requested',
      attachmentPdfFile: notice.attachments?.pdfFile ?? '',
      attachmentHwpFile: notice.attachments?.hwpFile ?? '',
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

    const where = search
      ? [
          { subject: ILike(`%${search}%`) },
          { proposalReason: ILike(`%${search}%`) },
          { committee: ILike(`%${search}%`) },
        ]
      : undefined;

    const [rows, total] = await this.archiveRepository.findAndCount({
      where,
      order: {
        noticeNum: 'DESC',
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
    const where = normalizedSearch
      ? [
          { subject: ILike(`%${normalizedSearch}%`) },
          { proposalReason: ILike(`%${normalizedSearch}%`) },
          { committee: ILike(`%${normalizedSearch}%`) },
        ]
      : undefined;

    const rows = await this.archiveRepository.find({
      where,
      order: {
        noticeNum: 'DESC',
      },
    });

    return rows.map((row) => this.mapArchiveEntityToNoticeItem(row));
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

    return {
      notice: this.mapArchiveEntityToNoticeItem(row),
      originalContent: {
        contentId: row.contentId ?? '',
        title: row.sourceTitle?.trim() || row.subject,
        proposalReason: row.proposalReason || '',
      },
    };
  }

  async existsByNoticeNum(noticeNum: number): Promise<boolean> {
    return this.archiveRepository.exists({ where: { noticeNum } });
  }

  async getArchiveCount(): Promise<number> {
    return this.archiveRepository.count();
  }

  private mapArchiveEntityToNoticeItem(row: NoticeArchive): ArchiveNoticeItem {
    return {
      num: row.noticeNum,
      subject: row.subject,
      proposerCategory: row.proposerCategory,
      committee: row.committee,
      numComments: row.numComments,
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
}
