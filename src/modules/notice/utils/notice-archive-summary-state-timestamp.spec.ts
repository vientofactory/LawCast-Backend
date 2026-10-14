import { DataSource, type Repository } from 'typeorm';
import { NoticeArchiveSnapshotState } from '../notice-archive-summary-state.entity';
import {
  type NoticeArchiveMaintenanceDeps,
  updateSummaryStateByNoticeNum,
  updateSummaryStatesByNoticeNums,
} from './notice-archive-maintenance-support';
import { AI_SUMMARY_STATUS } from '../../crawling/utils/ai-summary-status.utils';

/**
 * `updated_at` is the only way an operator can tell which rows a summary
 * backfill pass actually wrote, so every summary-state write path has to move
 * it. These assertions run against a real SQLite schema: a mocked repository
 * cannot show whether an `ON CONFLICT DO UPDATE` clause touches the column.
 */
const BACKDATED = '2020-01-01 00:00:00';

describe('notice archive summary state write timestamps', () => {
  let dataSource: DataSource;
  let repository: Repository<NoticeArchiveSnapshotState>;

  const deps = (): NoticeArchiveMaintenanceDeps =>
    ({
      summaryStateRepository: repository,
      logger: { warn: jest.fn() },
    }) as unknown as NoticeArchiveMaintenanceDeps;

  const readUpdatedAt = async (noticeNum: number): Promise<string> => {
    const rows = (await dataSource.query(
      `SELECT "updated_at" AS "updatedAt" FROM "notice_archive_snapshot_states" WHERE "notice_num" = ?`,
      [noticeNum],
    )) as Array<{ updatedAt: string }>;
    return rows[0]?.updatedAt;
  };

  const seedRow = async (noticeNum: number): Promise<void> => {
    await repository.insert({
      noticeNum,
      isDone: false,
      aiSummary: null,
      aiSummaryStatus: AI_SUMMARY_STATUS.NOT_REQUESTED,
    });
    await dataSource.query(
      `UPDATE "notice_archive_snapshot_states" SET "updated_at" = ? WHERE "notice_num" = ?`,
      [BACKDATED, noticeNum],
    );
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

  it('advances updated_at on the bulk upsert the summary backfill applies', async () => {
    await seedRow(91001);
    const before = await readUpdatedAt(91001);

    await updateSummaryStatesByNoticeNums(deps(), [
      {
        noticeNum: 91001,
        summary: '백필 요약',
        status: AI_SUMMARY_STATUS.READY,
      },
    ]);

    const row = await repository.findOneOrFail({
      where: { noticeNum: 91001 },
    });
    const after = await readUpdatedAt(91001);

    // The upsert still persists the summary it was given...
    expect(row.aiSummary).toBe('백필 요약');
    expect(row.aiSummaryStatus).toBe(AI_SUMMARY_STATUS.READY);
    // ...and the write is now visible as a timestamp, not just a status.
    expect(after > before).toBe(true);
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

    const after = await readUpdatedAt(91002);
    expect(after > before).toBe(true);
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

  it('advances updated_at on a repeated bulk upsert that writes the same text', async () => {
    await seedRow(91004);
    await updateSummaryStatesByNoticeNums(deps(), [
      {
        noticeNum: 91004,
        summary: '첫 요약',
        status: AI_SUMMARY_STATUS.READY,
      },
    ]);

    // Backdate so the next write is measured against a known-old value: SQLite
    // timestamps have one-second resolution, so two writes in the same second
    // are legitimately equal.
    await dataSource.query(
      `UPDATE "notice_archive_snapshot_states" SET "updated_at" = ? WHERE "notice_num" = ?`,
      [BACKDATED, 91004],
    );

    // A later pass that rewrites the same text must still be distinguishable
    // from a row no pass ever touched.
    await updateSummaryStatesByNoticeNums(deps(), [
      {
        noticeNum: 91004,
        summary: '첫 요약',
        status: AI_SUMMARY_STATUS.READY,
      },
    ]);

    const second = await readUpdatedAt(91004);
    expect(second > BACKDATED).toBe(true);
  });
});
