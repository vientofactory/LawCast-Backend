import { describe, expect, it, jest } from '@jest/globals';
import { DataSource } from 'typeorm';
import { NoticeArchive } from '../notice-archive.entity';
import { AddArchiveNoticeNumStartedAtIndex1755561601000 } from '../../../migrations/202608190001-add-archive-notice-num-started-at-index.migration';
import { getArchiveStartedAtByNoticeNums } from './notice-archive-maintenance-support';
import { NoticeArchiveArtifactSupport } from './notice-archive-artifact-support';

describe('notice archive performance paths', () => {
  it('uses the covering index for archive timestamp lookup', async () => {
    const dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [NoticeArchive],
      synchronize: true,
    });
    await dataSource.initialize();

    try {
      const queryRunner = dataSource.createQueryRunner();
      await new AddArchiveNoticeNumStartedAtIndex1755561601000().up(
        queryRunner,
      );
      await dataSource.query(
        `INSERT INTO "notice_archives"
           ("noticeNum", "subject", "proposerCategory", "committee",
            "assemblyLink", "proposalReason", "attachmentPdfFile",
            "attachmentHwpFile", "lifecycle_status", "archive_started_at")
         VALUES (?, 'subject', 'member', 'committee', 'link', '', '', '',
                 'active', ?)`,
        [2200001, '2026-08-19 00:00:00.000'],
      );
      const archiveRepository = dataSource.getRepository(NoticeArchive);

      const result = await getArchiveStartedAtByNoticeNums(
        {
          archiveRepository,
          artifactSupport: {} as any,
          logger: { warn: jest.fn() },
        },
        [2200001],
      );

      expect(result.get(2200001)?.getTime()).toBe(
        new Date('2026-08-19 00:00:00.000').getTime(),
      );
      const plan = (await dataSource.query(
        `EXPLAIN QUERY PLAN
         SELECT "noticeNum", "archive_started_at"
         FROM "notice_archives"
         INDEXED BY "idx_notice_archives_notice_num_archive_started_at"
         WHERE "noticeNum" IN (?)`,
        [2200001],
      )) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join('\n')).toMatch(
        /USING COVERING INDEX idx_notice_archives_notice_num_archive_started_at/,
      );
      await queryRunner.release();
    } finally {
      await dataSource.destroy();
    }
  });

  it('does not load source HTML or screenshot BLOB for complete detail metadata', async () => {
    const row = {
      noticeNum: 2200001,
      subject: 'subject',
      proposerCategory: 'member',
      committee: 'committee',
      assemblyLink: 'link',
      contentId: 'content-id',
      proposalReason: 'reason',
      sourceTitle: 'title',
      contentBillNumber: 'bill-number',
      contentProposer: 'proposer',
      contentProposalDate: '2026-08-19',
      contentCommittee: 'content-committee',
      contentReferralDate: '2026-08-19',
      contentNoticePeriod: 'period',
      contentProposalSession: 'session',
      attachmentPdfFile: '',
      attachmentHwpFile: '',
      archivedAt: new Date('2026-08-19T00:00:00.000Z'),
      sourceHtmlSha256: 'hash',
      integrityVerifiedAt: null,
      integrityCheckPassed: null,
      httpMetadataJson: '{}',
      httpFetchedAt: null,
      httpStatusCode: 200,
      httpContentType: 'text/html',
      httpEtag: null,
      httpLastModified: null,
      lifecycleStatus: 'active',
      sourceDeletedAt: null,
      screenshotFormat: 'jpeg',
      archiveStartedAt: new Date('2026-08-19T00:00:00.000Z'),
      aiSummary: null,
      aiSummaryStatus: 'not_requested',
      isDone: false,
    } as NoticeArchive;
    const findOne = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue(row);
    const repository = {
      findOne,
      query: jest
        .fn<(...args: any[]) => Promise<any[]>>()
        .mockResolvedValue([{ sourceHtmlSize: 1234, hasScreenshot: 1 }]),
    };
    const integrityStateRepository = {
      findOne: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        latestResult: 'passed',
        latestCheckedAt: new Date('2026-08-19T00:00:00.000Z'),
        latestCalculatedSha256: 'hash',
        lastSkipReason: null,
      }),
    };
    const support = new NoticeArchiveArtifactSupport(
      repository as any,
      undefined,
      integrityStateRepository as any,
    );

    const result = await support.getArchivedNoticeDetail(2200001);

    expect(result?.archiveMetadata.sourceHtmlSize).toBe(1234);
    expect(result?.screenshotMeta.hasScreenshot).toBe(true);
    expect(findOne).toHaveBeenCalledTimes(1);
    const projection = findOne.mock.calls[0][0].select;
    expect(projection).not.toHaveProperty('sourceHtml');
    expect(projection).not.toHaveProperty('screenshotBlob');
  });
});
