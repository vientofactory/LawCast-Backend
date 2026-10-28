import { DataSource } from 'typeorm';
import { migrations } from '../../migrations';
import { ChangeTrackingService } from './change-tracking.service';
import { NoticeChangeEvent } from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';

describe('Comparable summary reads on the shared SQLite connection', () => {
  let db: DataSource;
  let service: ChangeTrackingService;

  beforeEach(async () => {
    db = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [NoticeChangeEvent, NoticeChangeDetail],
      migrations,
      synchronize: false,
    });
    await db.initialize();
    await db.runMigrations();
    service = new ChangeTrackingService(
      db.getRepository(NoticeChangeEvent),
      db.getRepository(NoticeChangeDetail),
      {} as never,
      {} as never,
      {} as never,
    );
  });
  afterEach(async () => {
    await db?.destroy();
  });

  async function insert(noticeNum: number, height: number) {
    await db.query(
      `INSERT INTO notice_change_events (notice_num,event_type,event_height,event_hash,detected_at)
       VALUES (?, 'updated', ?, ?, '2026-10-28 12:00:00')`,
      [noticeNum, height, `${noticeNum}-${height}`.padStart(64, '0')],
    );
  }

  it('counts only comparable events and distinct notices in one query', async () => {
    for (const [num, height] of [
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 2],
    ]) {
      await insert(num, height);
    }
    const builders = jest.spyOn(
      db.getRepository(NoticeChangeEvent),
      'createQueryBuilder',
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.getComparableChangeSummary()),
    );
    expect(
      results.every(
        (value) =>
          value.comparableEventTotal === 3 && value.comparableNoticeCount === 2,
      ),
    ).toBe(true);
    expect(builders).toHaveBeenCalledTimes(1);
    results[0].comparableEventTotal = 999;
    expect(results[1].comparableEventTotal).toBe(3);
    await insert(2, 3);
    expect(await service.getComparableChangeSummary()).toEqual({
      comparableEventTotal: 4,
      comparableNoticeCount: 2,
    });
    builders.mockRestore();
  });

  it('clears a failed in-flight read so a later request can recover', async () => {
    const repo = db.getRepository(NoticeChangeEvent);
    const builders = jest.spyOn(repo, 'createQueryBuilder');
    const failed = repo.createQueryBuilder('event');
    jest
      .spyOn(failed, 'getRawOne')
      .mockRejectedValueOnce(new Error('read failed'));
    builders.mockReturnValueOnce(failed);
    await expect(service.getComparableChangeSummary()).rejects.toThrow(
      'read failed',
    );
    expect(await service.getComparableChangeSummary()).toEqual({
      comparableEventTotal: 0,
      comparableNoticeCount: 0,
    });
    builders.mockRestore();
  });
});
