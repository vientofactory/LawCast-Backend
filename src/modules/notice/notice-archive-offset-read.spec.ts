import { DataSource } from 'typeorm';
import { migrations } from '../../migrations';
import { NoticeArchive } from './notice-archive.entity';
import { NoticeArchiveSnapshotState } from './notice-archive-summary-state.entity';
import { NoticeArchiveService } from './notice-archive.service';

describe('Archive offset filtering and query budget', () => {
  let db: DataSource;
  let service: NoticeArchiveService;
  const queries: string[] = [];

  beforeAll(async () => {
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [NoticeArchive, NoticeArchiveSnapshotState],
      migrations,
      logging: ['query'],
      logger: {
        logQuery: (sql) => queries.push(sql),
        logQueryError() {},
        logQuerySlow() {},
        logSchemaBuild() {},
        logMigration() {},
        log() {},
      },
    });
    await db.initialize();
    await db.runMigrations();
    for (let num = 1; num <= 4; num++) {
      await db.getRepository(NoticeArchive).save({
        noticeNum: num,
        subject: 'Fixture',
        proposerCategory: '의원',
        committee: 'Fixture',
        assemblyLink: 'https://example.test',
      });
      if (num < 4) {
        await db.getRepository(NoticeArchiveSnapshotState).save({
          noticeNum: num,
          isDone: num === 2,
          aiSummaryStatus: 'not_supported',
        });
      }
    }
    service = new NoticeArchiveService(
      db.getRepository(NoticeArchive),
      db.getRepository(NoticeArchiveSnapshotState),
      { getLatestFieldValuesForFields: async () => new Map() } as never,
      {} as never,
      undefined as never,
      undefined as never,
    );
  });

  beforeEach(() => {
    queries.length = 0;
  });
  afterAll(async () => db?.destroy());

  it.each([false, true])(
    'preserves isDone=%s with and without knownTotal in both orders',
    async (isDone) => {
      const total = isDone ? 1 : 2;
      for (const sortOrder of ['asc', 'desc'] as const) {
        const expected = isDone ? [2] : sortOrder === 'asc' ? [1, 3] : [3, 1];
        for (const knownTotal of [undefined, total]) {
          queries.length = 0;
          const result = await service.getArchiveNoticesByOffset({
            skip: 0,
            take: 2,
            isDone,
            sortOrder,
            knownTotal,
          });
          expect(result.items.map((item) => item.num)).toEqual(expected);
          expect(result.items.every((item) => item.isDone === isDone)).toBe(
            true,
          );
          expect(result.total).toBe(total);
          expect(
            queries.filter((sql) => sql.includes('EXISTS (')),
          ).toHaveLength(1);
        }
      }
    },
  );

  it('does not repeat an empty page or load rows for a count-only request', async () => {
    expect(
      (
        await service.getArchiveNoticesByOffset({
          skip: 10,
          take: 2,
          isDone: false,
        })
      ).items,
    ).toEqual([]);
    expect(queries.filter((sql) => sql.includes('EXISTS ('))).toHaveLength(1);
    queries.length = 0;
    expect(
      await service.getArchiveNoticesByOffset({
        skip: 0,
        take: 0,
        isDone: false,
      }),
    ).toEqual({ items: [], total: 2, search: '' });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('COUNT');
    queries.length = 0;
    expect(
      (
        await service.getArchiveNoticesByOffset({
          skip: 0,
          take: 0,
          isDone: false,
          knownTotal: 2,
        })
      ).total,
    ).toBe(2);
    expect(queries).toHaveLength(0);
  });

  it('preserves skip, take, known counts and unfiltered rows without isDone', async () => {
    const result = await service.getArchiveNoticesByOffset({
      skip: 1,
      take: 2,
      sortOrder: 'desc',
      knownTotal: 4,
    });
    expect(result.items.map((item) => item.num)).toEqual([3, 2]);
    expect(result.total).toBe(4);
    expect(queries.every((sql) => !sql.includes('COUNT'))).toBe(true);
  });
});
