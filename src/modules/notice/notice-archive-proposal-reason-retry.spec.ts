import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DataSource } from 'typeorm';
import { migrations } from '../../migrations';
import { NoticeArchive } from './notice-archive.entity';
import { NoticeArchiveIntegrityCheck } from './notice-archive-integrity-check.entity';
import { NoticeArchiveIntegrityState } from './notice-archive-integrity-state.entity';
import { NoticeArchiveService } from './notice-archive.service';
import { NoticeArchiveSnapshotState } from './notice-archive-summary-state.entity';

/**
 * Runs the proposalReason retry candidate query against a real SQLite schema
 * built by the full migration chain.
 *
 * The candidate page is decided entirely in SQL - the empty-reason predicate,
 * the two change-chain `NOT EXISTS` guards, and the ORDER BY that has to keep
 * the cursor moving. Mocked repositories cannot see any of it, so the
 * behaviour that stops the page from pinning on rows whose reason no source
 * can supply is verified here (see
 * `agent_memories/39-likms-reason-backfill-throughput/`).
 */
describe('NoticeArchiveService proposalReason retry candidate cursor (real SQLite schema)', () => {
  let dataSource: DataSource;
  let service: NoticeArchiveService;

  const attemptAt = (iso: string) => new Date(iso);

  /**
   * Inserts an archived notice with an empty proposalReason, which is what
   * makes it a retry candidate. `contentId: null` plus no bill number mirrors
   * the production head - non-bill agenda items (`사직의건`/`결의안`) that no
   * source can supply a reason for.
   */
  const insertReasonlessNotice = async (params: {
    noticeNum: number;
    contentId?: string | null;
    contentBillNumber?: string | null;
  }): Promise<void> => {
    const repository = dataSource.getRepository(NoticeArchive);

    await repository.save(
      repository.create({
        noticeNum: params.noticeNum,
        subject: `테스트 법률안 ${params.noticeNum}`,
        proposerCategory: '의원',
        committee: '법제사법위원회',
        assemblyLink: `https://example.com/${params.noticeNum}`,
        contentId: params.contentId ?? null,
        proposalReason: '',
        sourceTitle: null,
        contentBillNumber:
          params.contentBillNumber === undefined
            ? String(params.noticeNum)
            : params.contentBillNumber,
        contentProposer: null,
        contentProposalDate: null,
        contentCommittee: null,
        contentReferralDate: null,
        contentNoticePeriod: null,
        contentProposalSession: null,
        attachmentPdfFile: '',
        attachmentHwpFile: '',
        archivedAt: new Date('2026-10-01T00:00:00.000Z'),
        sourceHtml: '<html>snapshot</html>',
        sourceHtmlSha256: 'a'.repeat(64),
        integrityVerifiedAt: null,
        integrityCheckPassed: null,
        httpMetadataJson: null,
        httpFetchedAt: null,
        httpStatusCode: null,
        httpContentType: null,
        httpEtag: null,
        httpLastModified: null,
        sourceDeletedAt: null,
        nsmLastSeenInListAt: null,
        nsmListAbsenceProbedAt: null,
        proposalReasonRetryCount: 0,
        proposalReasonRetriedAt: null,
        screenshotBlob: null,
        screenshotFormat: null,
        screenshotCaptureStatus: null,
        screenshotCaptureError: null,
      }),
    );
  };

  const readRetryStamp = async (
    noticeNum: number,
  ): Promise<{ count: number; attemptedAt: Date | null }> => {
    const row = await dataSource.getRepository(NoticeArchive).findOneOrFail({
      where: { noticeNum },
    });

    return {
      count: row.proposalReasonRetryCount,
      attemptedAt: row.proposalReasonRetriedAt
        ? new Date(row.proposalReasonRetriedAt)
        : null,
    };
  };

  const candidateNums = async (limit: number): Promise<number[]> => {
    const candidates = await service.getProposalReasonRetryCandidates(limit);
    return candidates.map(({ notice }) => notice.num);
  };

  /**
   * The production shape: twenty unrecoverable rows with the lowest notice
   * numbers sit in front of the rows that do have a recoverable reason.
   */
  const seedWedgedHead = async (): Promise<{
    head: number[];
    real: number[];
  }> => {
    const head = Array.from({ length: 20 }, (_, index) => 20490 + index);
    const real = [2219108, 2219875];

    for (const noticeNum of head) {
      await insertReasonlessNotice({ noticeNum, contentId: null });
    }

    for (const noticeNum of real) {
      // A real bill: it has a likms contentId, so the reason is recoverable.
      await insertReasonlessNotice({
        noticeNum,
        contentId: `PRC_${noticeNum}`,
      });
    }

    return { head, real };
  };

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      synchronize: false,
      migrationsRun: false,
      migrations,
      entities: [
        NoticeArchive,
        NoticeArchiveSnapshotState,
        NoticeArchiveIntegrityCheck,
        NoticeArchiveIntegrityState,
      ],
    });

    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });

    service = new NoticeArchiveService(
      dataSource.getRepository(NoticeArchive),
      dataSource.getRepository(NoticeArchiveSnapshotState),
      {} as never,
      { logEvent: jest.fn() } as never,
      dataSource.getRepository(NoticeArchiveIntegrityCheck),
      dataSource.getRepository(NoticeArchiveIntegrityState),
    );
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('returns the same head every time while nothing records an attempt', async () => {
    const { head } = await seedWedgedHead();

    const firstPage = await candidateNums(20);
    const secondPage = await candidateNums(20);

    expect(firstPage).toEqual(head);
    // Without attempt stamps the cursor cannot move: this is the production
    // wedge the stamps exist to break.
    expect(secondPage).toEqual(firstPage);
  });

  it('advances past the head once the attempted rows carry a stamp', async () => {
    const { head, real } = await seedWedgedHead();

    const firstPage = await candidateNums(20);
    expect(firstPage).toEqual(head);

    const stamped = await service.recordProposalReasonAttempts(
      firstPage,
      attemptAt('2026-10-15T00:00:00.000Z'),
    );
    expect(stamped).toBe(20);

    // The recoverable rows behind the head are now served first, which is the
    // whole point: before the stamps the page never contained them at all.
    const secondPage = await candidateNums(20);
    expect(secondPage.slice(0, real.length)).toEqual(real);
    expect(secondPage.slice(real.length)).toEqual(head.slice(0, 18));

    const stampedRow = await readRetryStamp(20490);
    expect(stampedRow.count).toBe(1);
    expect(stampedRow.attemptedAt?.toISOString()).toBe(
      '2026-10-15T00:00:00.000Z',
    );
  });

  it('rotates within a page instead of keeping one fixed first entry', async () => {
    await insertReasonlessNotice({ noticeNum: 20490 });
    await insertReasonlessNotice({ noticeNum: 20491 });
    await insertReasonlessNotice({ noticeNum: 20492 });

    expect(await candidateNums(3)).toEqual([20490, 20491, 20492]);

    await service.recordProposalReasonAttempts(
      [20490],
      attemptAt('2026-10-15T00:00:01.000Z'),
    );
    expect(await candidateNums(3)).toEqual([20491, 20492, 20490]);

    await service.recordProposalReasonAttempts(
      [20491],
      attemptAt('2026-10-15T00:00:02.000Z'),
    );
    // Equal attempt count breaks by the oldest attempt, so the row attempted
    // first is served first within its bucket.
    expect(await candidateNums(3)).toEqual([20492, 20490, 20491]);
  });

  it('serves a newly arrived candidate before rows that already failed', async () => {
    await insertReasonlessNotice({ noticeNum: 20490 });
    await insertReasonlessNotice({ noticeNum: 20491 });

    await service.recordProposalReasonAttempts(
      [20490, 20491],
      attemptAt('2026-10-15T00:00:00.000Z'),
    );

    // A bill archived after the earlier attempts: it has never been tried, so
    // its higher notice number does not put it behind the failed rows.
    await insertReasonlessNotice({
      noticeNum: 2221827,
      contentId: 'PRC_2221827',
    });

    expect(await candidateNums(5)).toEqual([2221827, 20490, 20491]);
  });

  it('counts every attempt and keeps the newest attempt time', async () => {
    await insertReasonlessNotice({ noticeNum: 20490 });

    await service.recordProposalReasonAttempts(
      [20490, 20490],
      attemptAt('2026-10-15T00:00:00.000Z'),
    );
    await service.recordProposalReasonAttempts(
      [20490],
      attemptAt('2026-10-15T01:00:00.000Z'),
    );

    const stamp = await readRetryStamp(20490);
    // Two attempts in one call collapse into one row, then the second call
    // increments again.
    expect(stamp.count).toBe(2);
    expect(stamp.attemptedAt?.toISOString()).toBe('2026-10-15T01:00:00.000Z');
  });

  it('ignores non-row inputs when stamping attempts', async () => {
    await insertReasonlessNotice({ noticeNum: 20490 });

    const stamped = await service.recordProposalReasonAttempts([
      0, -1, 20490.5,
    ]);

    expect(stamped).toBe(0);
    expect((await readRetryStamp(20490)).count).toBe(0);
  });

  it('still excludes rows whose reason arrived through the change chain', async () => {
    await insertReasonlessNotice({
      noticeNum: 2219108,
      contentId: 'PRC_2219108',
    });

    await dataSource.query(
      `INSERT INTO notice_change_events
        (notice_num, detected_at, event_type, event_height, event_hash)
      VALUES (?, ?, 'updated', 1, ?)`,
      [2219108, '2026-10-14 09:49:41', 'b'.repeat(64)],
    );
    await dataSource.query(
      `INSERT INTO notice_change_details
         (event_id, field_path, change_type, after_value)
       VALUES ((SELECT MAX(id) FROM notice_change_events), 'proposalReason', 'modified', ?)`,
      ['복구된 제안이유'],
    );

    expect(await candidateNums(20)).toEqual([]);
  });
});
