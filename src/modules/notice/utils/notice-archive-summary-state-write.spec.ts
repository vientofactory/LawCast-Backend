import { DataSource, type Repository } from 'typeorm';
import { NoticeArchiveSnapshotState } from '../notice-archive-summary-state.entity';
import {
  type NoticeArchiveMaintenanceDeps,
  type SummaryStateWriteStats,
  updateSummaryStateByNoticeNum,
  updateSummaryStatesByNoticeNums,
} from './notice-archive-maintenance-support';
import { AI_SUMMARY_STATUS } from '../../crawling/utils/ai-summary-status.utils';

/**
 * Two properties of the summary-state write paths that only a real SQLite
 * schema can show, because both are about the SQL that reaches the database:
 *
 * 1. a write that changes the verdict stamps `updated_at`, so a changed row is
 *    distinguishable from one no pass ever touched; and
 * 2. a write that re-derives the verdict a row already holds never reaches the
 *    table at all, so the backfill's steady state stops rewriting the same
 *    rows on every pass.
 *
 * `total_changes()` is the assertion for (2). It counts the rows SQLite
 * actually inserted, updated or deleted, so rewriting a row with identical
 * values - still a write, still WAL traffic - fails the check even though the
 * stored values are then indistinguishable.
 */
const BACKDATED = '2020-01-01 00:00:00';

describe('notice archive summary state writes', () => {
  let dataSource: DataSource;
  let repository: Repository<NoticeArchiveSnapshotState>;

  const deps = (): NoticeArchiveMaintenanceDeps =>
    ({
      summaryStateRepository: repository,
      logger: { warn: jest.fn() },
    }) as unknown as NoticeArchiveMaintenanceDeps;

  const newStats = (): SummaryStateWriteStats => ({
    changed: 0,
    skipped: 0,
    changedNoticeNums: new Set<number>(),
  });

  // The counters and the named set have to agree: callers mirror the verdict
  // into the recent-notices cache using exactly this set.
  const readStats = (stats: SummaryStateWriteStats) => ({
    changed: stats.changed,
    skipped: stats.skipped,
    changedNoticeNums: Array.from(stats.changedNoticeNums),
  });

  const readUpdatedAt = async (noticeNum: number): Promise<string> => {
    const rows = (await dataSource.query(
      `SELECT "updated_at" AS "updatedAt" FROM "notice_archive_snapshot_states" WHERE "notice_num" = ?`,
      [noticeNum],
    )) as Array<{ updatedAt: string }>;
    return rows[0]?.updatedAt;
  };

  const totalChanges = async (): Promise<number> => {
    const rows = (await dataSource.query(
      'SELECT total_changes() AS total',
    )) as Array<{ total: number }>;
    return Number(rows[0]?.total ?? 0);
  };

  const backdate = async (noticeNum: number): Promise<void> => {
    await dataSource.query(
      `UPDATE "notice_archive_snapshot_states" SET "updated_at" = ? WHERE "notice_num" = ?`,
      [BACKDATED, noticeNum],
    );
  };

  const seedRow = async (noticeNum: number): Promise<void> => {
    await repository.insert({
      noticeNum,
      isDone: false,
      aiSummary: null,
      aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED,
    });
    await backdate(noticeNum);
  };

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [NoticeArchiveSnapshotState],
      synchronize: true,
    });
    await dataSource.initialize();
    repository = dataSource.getRepository(NoticeArchiveSnapshotState);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe('verdict changes', () => {
    it('advances updated_at on the bulk upsert the summary backfill applies', async () => {
      await seedRow(91001);
      const before = await readUpdatedAt(91001);
      const stats = newStats();

      await updateSummaryStatesByNoticeNums(
        deps(),
        [
          {
            noticeNum: 91001,
            summary: '백필 요약',
            status: AI_SUMMARY_STATUS.READY,
          },
        ],
        stats,
      );

      const row = await repository.findOneOrFail({
        where: { noticeNum: 91001 },
      });

      // The upsert still persists the summary it was given...
      expect(row.aiSummary).toBe('백필 요약');
      expect(row.aiSummaryStatus).toBe(AI_SUMMARY_STATUS.READY);
      // ...and the write is visible as a timestamp, not just as a status.
      expect((await readUpdatedAt(91001)) > before).toBe(true);
      expect(readStats(stats)).toEqual({
        changed: 1,
        skipped: 0,
        changedNoticeNums: [91001],
      });
    });

    it('advances updated_at on the single-row summary write', async () => {
      await seedRow(91002);
      const before = await readUpdatedAt(91002);

      await updateSummaryStateByNoticeNum(
        deps(),
        91002,
        '단건 요약',
        AI_SUMMARY_STATUS.READY,
      );

      expect((await readUpdatedAt(91002)) > before).toBe(true);
    });

    it('stamps updated_at when the bulk upsert inserts a new row', async () => {
      await updateSummaryStatesByNoticeNums(deps(), [
        {
          noticeNum: 91003,
          summary: '새 요약',
          status: AI_SUMMARY_STATUS.READY,
        },
      ]);

      const after = await readUpdatedAt(91003);
      expect(after).toBeTruthy();
      expect(after > BACKDATED).toBe(true);
    });

    it('writes the new verdict for a row an earlier pass skipped', async () => {
      await seedRow(91004);

      // First verdict for the row: `not_supported` with no reason anywhere -
      // the state the backfill re-derives for every unrecoverable row.
      await updateSummaryStateByNoticeNum(
        deps(),
        91004,
        null,
        AI_SUMMARY_STATUS.NOT_SUPPORTED,
      );
      await backdate(91004);

      // A later pass re-deriving the same verdict leaves the row alone...
      await updateSummaryStateByNoticeNum(
        deps(),
        91004,
        null,
        AI_SUMMARY_STATUS.NOT_SUPPORTED,
      );
      expect(await readUpdatedAt(91004)).toBe(BACKDATED);

      // ...but the first real change (a reason that finally arrived) is written.
      await updateSummaryStateByNoticeNum(
        deps(),
        91004,
        '나중에 복구된 요약',
        AI_SUMMARY_STATUS.READY,
      );

      const row = await repository.findOneOrFail({
        where: { noticeNum: 91004 },
      });
      expect(row.aiSummaryStatus).toBe(AI_SUMMARY_STATUS.READY);
      expect(row.aiSummary).toBe('나중에 복구된 요약');
      expect((await readUpdatedAt(91004)) > BACKDATED).toBe(true);
    });
  });

  describe('unchanged verdicts', () => {
    it('skips the bulk write when the pass re-derives the verdict already stored', async () => {
      await seedRow(91005);
      await updateSummaryStatesByNoticeNums(deps(), [
        {
          noticeNum: 91005,
          summary: '불변 요약',
          status: AI_SUMMARY_STATUS.READY,
        },
      ]);
      // Backdate so a write is measurable: SQLite timestamps have one-second
      // resolution, so two writes inside the same second compare equal.
      await backdate(91005);

      const before = await totalChanges();
      const stats = newStats();

      await updateSummaryStatesByNoticeNums(
        deps(),
        [
          {
            noticeNum: 91005,
            summary: '불변 요약',
            status: AI_SUMMARY_STATUS.READY,
          },
        ],
        stats,
      );

      // No statement ran for the row, so the timestamp still marks the pass
      // that actually wrote the verdict.
      expect((await totalChanges()) - before).toBe(0);
      expect(await readUpdatedAt(91005)).toBe(BACKDATED);
      expect(readStats(stats)).toEqual({
        changed: 0,
        skipped: 1,
        changedNoticeNums: [],
      });
    });

    it('skips only the unchanged rows of a mixed batch', async () => {
      await seedRow(91006);
      await seedRow(91007);
      await updateSummaryStatesByNoticeNums(deps(), [
        {
          noticeNum: 91006,
          summary: null,
          status: AI_SUMMARY_STATUS.NOT_SUPPORTED,
        },
        {
          noticeNum: 91007,
          summary: null,
          status: AI_SUMMARY_STATUS.NOT_SUPPORTED,
        },
      ]);
      await backdate(91006);
      await backdate(91007);

      const before = await totalChanges();
      const stats = newStats();

      await updateSummaryStatesByNoticeNums(
        deps(),
        [
          // Same verdict as stored: dropped from the statement.
          {
            noticeNum: 91006,
            summary: null,
            status: AI_SUMMARY_STATUS.NOT_SUPPORTED,
          },
          // Reason arrived for this one: written.
          {
            noticeNum: 91007,
            summary: '복구된 요약',
            status: AI_SUMMARY_STATUS.READY,
          },
        ],
        stats,
      );

      expect((await totalChanges()) - before).toBe(1);
      expect(readStats(stats)).toEqual({
        changed: 1,
        skipped: 1,
        changedNoticeNums: [91007],
      });
      expect(await readUpdatedAt(91006)).toBe(BACKDATED);
      expect((await readUpdatedAt(91007)) > BACKDATED).toBe(true);
    });

    it('skips the single-row write when the verdict is unchanged', async () => {
      await seedRow(91008);
      await updateSummaryStateByNoticeNum(
        deps(),
        91008,
        null,
        AI_SUMMARY_STATUS.NOT_SUPPORTED,
      );
      await backdate(91008);

      const before = await totalChanges();

      await updateSummaryStateByNoticeNum(
        deps(),
        91008,
        null,
        AI_SUMMARY_STATUS.NOT_SUPPORTED,
      );

      expect((await totalChanges()) - before).toBe(0);
      expect(await readUpdatedAt(91008)).toBe(BACKDATED);
    });

    it('treats a whitespace-only summary as the null it is stored as', async () => {
      await seedRow(91009);
      await updateSummaryStatesByNoticeNums(deps(), [
        {
          noticeNum: 91009,
          summary: null,
          status: AI_SUMMARY_STATUS.NOT_SUPPORTED,
        },
      ]);
      await backdate(91009);

      const before = await totalChanges();

      await updateSummaryStatesByNoticeNums(deps(), [
        {
          noticeNum: 91009,
          summary: '   ',
          status: AI_SUMMARY_STATUS.NOT_SUPPORTED,
        },
      ]);

      // The write path normalizes blank text to null, so this is the same
      // verdict and must not rewrite the row.
      expect((await totalChanges()) - before).toBe(0);
      expect(await readUpdatedAt(91009)).toBe(BACKDATED);
    });
  });
});
