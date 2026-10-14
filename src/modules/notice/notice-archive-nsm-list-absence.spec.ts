import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { DataSource } from 'typeorm';
import { migrations } from '../../migrations';
import {
  NOTICE_LIFECYCLE_STATUS,
  NoticeArchive,
} from './notice-archive.entity';
import { NoticeArchiveIntegrityCheck } from './notice-archive-integrity-check.entity';
import { NoticeArchiveIntegrityState } from './notice-archive-integrity-state.entity';
import { NoticeArchiveService } from './notice-archive.service';
import { NoticeArchiveSnapshotState } from './notice-archive-summary-state.entity';

/**
 * Runs NSM list-absence reconciliation against a real SQLite schema built by
 * the full migration chain.
 *
 * The candidate set is decided by SQL (`nsm_last_seen_in_list_at` comparisons
 * plus a cooldown on `nsm_list_absence_probed_at`), and the tracking writes land
 * on `notice_archives`, whose immutability trigger can abort an UPDATE. Mocked
 * repositories cannot see either, so the behaviour that keeps a blocked or
 * mismatched list source from re-probing the whole archive every cycle is
 * verified here against the real schema.
 */
describe('NoticeArchiveService NSM list-absence tracking (real SQLite schema)', () => {
  let dataSource: DataSource;
  let service: NoticeArchiveService;
  let appendSourceDeletedSpy: ReturnType<typeof jest.spyOn>;

  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 60 * 60 * 1000);

  const insertNotice = async (params: {
    noticeNum: number;
    contentId?: string | null;
    contentBillNumber?: string | null;
    nsmLastSeenInListAt?: Date | null;
    nsmListAbsenceProbedAt?: Date | null;
    lifecycleStatus?: string;
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
        proposalReason: '제안이유 본문',
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
        lifecycleStatus:
          (params.lifecycleStatus as NoticeArchive['lifecycleStatus']) ??
          NOTICE_LIFECYCLE_STATUS.ACTIVE,
        sourceDeletedAt: null,
        nsmLastSeenInListAt: params.nsmLastSeenInListAt ?? null,
        nsmListAbsenceProbedAt: params.nsmListAbsenceProbedAt ?? null,
        screenshotBlob: null,
        screenshotFormat: null,
        screenshotCaptureStatus: null,
        screenshotCaptureError: null,
      }),
    );
  };

  const readRow = async (noticeNum: number): Promise<NoticeArchive> => {
    const row = await dataSource
      .getRepository(NoticeArchive)
      .findOne({ where: { noticeNum } });

    if (!row) {
      throw new Error(`missing archive row ${noticeNum}`);
    }

    return row;
  };

  const probeRecordingDeletions = (
    deletedBillNos: string[] = [],
    outcome: 'alive' | 'blocked' | 'error' = 'alive',
  ) =>
    jest.fn(async (billNo: string) =>
      deletedBillNos.includes(billNo) ? 'deleted' : outcome,
    );

  beforeEach(async () => {
    process.env.CRAWLING_NSM_ENABLED = 'true';
    process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'true';

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

    // Marking is verified in notice-archive.service.spec.ts; here the point is
    // which rows get probed at all.
    appendSourceDeletedSpy = jest
      .spyOn(service, 'appendSourceDeletedEventByNoticeNum')
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    appendSourceDeletedSpy.mockRestore();
    delete process.env.CRAWLING_NSM_ENABLED;
    delete process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED;

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('stamps the sighting time for every notice the scan returned and probes nothing', async () => {
    await insertNotice({ noticeNum: 2219001 });
    await insertNotice({ noticeNum: 2219002 });
    const confirmDeletion = probeRecordingDeletions();

    const markedCount = await service.markSourceDeletedByMissingNsmNums(
      new Set([2219001, 2219002]),
      confirmDeletion,
    );

    expect(markedCount).toBe(0);
    expect(confirmDeletion).not.toHaveBeenCalled();

    const first = await readRow(2219001);
    const second = await readRow(2219002);
    expect(first.nsmLastSeenInListAt).toBeInstanceOf(Date);
    expect(second.nsmLastSeenInListAt).toBeInstanceOf(Date);
  });

  it('probes rows whose earlier sighting is older than this scan, not the rows the scan just returned', async () => {
    await insertNotice({
      noticeNum: 2219100,
      nsmLastSeenInListAt: hoursAgo(72),
    });
    await insertNotice({
      noticeNum: 2219101,
      nsmListAbsenceProbedAt: hoursAgo(1),
    });
    await insertNotice({ noticeNum: 2219102 });
    await insertNotice({
      noticeNum: 2219103,
      nsmLastSeenInListAt: hoursAgo(48),
    });
    const confirmDeletion = probeRecordingDeletions();

    await service.markSourceDeletedByMissingNsmNums(
      new Set([2219101]),
      confirmDeletion,
    );

    // 2219100 disappeared 72h ago and was never probed, 2219103 disappeared 48h
    // ago: both are candidates, oldest absence first. 2219101 was returned by
    // this scan (stamped now) so it is never a candidate, and 2219102 — never
    // seen in any list — only fills the slots left over (the cap is 50 here).
    expect(confirmDeletion.mock.calls.map(([billNo]) => billNo)).toEqual([
      '2219100',
      '2219103',
      '2219102',
    ]);
  });

  it('fills the remaining slots with never-seen rows only after the disappeared ones', async () => {
    await insertNotice({
      noticeNum: 2219200,
      nsmLastSeenInListAt: hoursAgo(30),
    });
    await insertNotice({ noticeNum: 2219201 });
    await insertNotice({ noticeNum: 2219202 });
    const confirmDeletion = probeRecordingDeletions();

    await service.markSourceDeletedByMissingNsmNums(
      new Set([2219203]),
      confirmDeletion,
      {
        maxCandidates: 2,
      },
    );

    expect(confirmDeletion.mock.calls.map(([billNo]) => billNo)).toEqual([
      '2219200',
      '2219201',
    ]);
  });

  it('does not re-probe an unconfirmed absence until the cooldown has elapsed', async () => {
    await insertNotice({
      noticeNum: 2219300,
      nsmLastSeenInListAt: hoursAgo(72),
    });
    const confirmDeletion = probeRecordingDeletions();

    await service.markSourceDeletedByMissingNsmNums(
      new Set([2219301]),
      confirmDeletion,
      { cooldownHours: 168 },
    );
    expect(confirmDeletion).toHaveBeenCalledTimes(1);
    expect((await readRow(2219300)).nsmListAbsenceProbedAt).toBeInstanceOf(
      Date,
    );

    // Same cycle shape again: the row is still absent from the list (its
    // sighting is old), yet the cooldown keeps it out of the candidate set.
    await service.markSourceDeletedByMissingNsmNums(
      new Set([2219301]),
      confirmDeletion,
      { cooldownHours: 168 },
    );
    expect(confirmDeletion).toHaveBeenCalledTimes(1);
  });

  it('re-probes an absence once the cooldown has elapsed', async () => {
    await insertNotice({
      noticeNum: 2219400,
      nsmLastSeenInListAt: hoursAgo(500),
      nsmListAbsenceProbedAt: hoursAgo(200),
    });
    const confirmDeletion = probeRecordingDeletions();

    await service.markSourceDeletedByMissingNsmNums(
      new Set([2219401]),
      confirmDeletion,
      { cooldownHours: 168 },
    );

    expect(confirmDeletion).toHaveBeenCalledWith('2219400');
  });

  it('ignores rows that are already source_deleted or were never NSM-originated', async () => {
    await insertNotice({
      noticeNum: 2219500,
      nsmLastSeenInListAt: hoursAgo(72),
      lifecycleStatus: NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED,
    });
    await insertNotice({
      noticeNum: 2219501,
      contentId: 'PRC_PAL_ONLY',
      nsmLastSeenInListAt: hoursAgo(72),
    });
    const confirmDeletion = probeRecordingDeletions();

    const markedCount = await service.markSourceDeletedByMissingNsmNums(
      new Set([2219502]),
      confirmDeletion,
    );

    expect(markedCount).toBe(0);
    expect(confirmDeletion).not.toHaveBeenCalled();
  });

  it('records sightings even while deletion detection is switched off', async () => {
    process.env.CRAWLING_NSM_DELETION_DETECTION_ENABLED = 'false';
    await insertNotice({ noticeNum: 2219600 });
    const confirmDeletion = probeRecordingDeletions();

    await service.markSourceDeletedByMissingNsmNums(
      new Set([2219600]),
      confirmDeletion,
    );

    expect(confirmDeletion).not.toHaveBeenCalled();
    expect((await readRow(2219600)).nsmLastSeenInListAt).toBeInstanceOf(Date);
  });

  it('leaves the immutable snapshot columns and lifecycle status untouched when stamping', async () => {
    await insertNotice({ noticeNum: 2219700 });

    await service.markSourceDeletedByMissingNsmNums(
      new Set([2219700]),
      undefined,
    );

    const row = await readRow(2219700);
    expect(row.sourceHtml).toBe('<html>snapshot</html>');
    expect(row.sourceHtmlSha256).toBe('a'.repeat(64));
    expect(row.subject).toBe('테스트 법률안 2219700');
    expect(row.lifecycleStatus).toBe(NOTICE_LIFECYCLE_STATUS.ACTIVE);
    expect(row.sourceDeletedAt).toBeNull();
  });

  it('stamps a full list scan in chunks and still probes only the cap', async () => {
    const seenNums: number[] = [];
    for (let index = 0; index < 2000; index++) {
      const noticeNum = 2300000 + index;
      seenNums.push(noticeNum);
      await insertNotice({ noticeNum });
    }
    // A handful of rows the scan did not return: only these are candidates.
    const disappeared = [2309000, 2309001, 2309002];
    for (const noticeNum of disappeared) {
      await insertNotice({ noticeNum, nsmLastSeenInListAt: hoursAgo(48) });
    }
    const confirmDeletion = probeRecordingDeletions();

    const startedAt = Date.now();
    await service.markSourceDeletedByMissingNsmNums(
      new Set(seenNums),
      confirmDeletion,
      { maxCandidates: 2 },
    );
    const elapsedMs = Date.now() - startedAt;

    expect(confirmDeletion.mock.calls.map(([billNo]) => billNo)).toEqual([
      '2309000',
      '2309001',
    ]);
    // Stamping 2,000 rows is chunked; a whole-archive sweep would take orders of
    // magnitude longer than this bound on the same data.
    expect(elapsedMs).toBeLessThan(10000);
  });
});
