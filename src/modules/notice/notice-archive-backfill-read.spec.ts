import { DataSource } from 'typeorm';
import { migrations } from '../../migrations';
import {
  NoticeArchive,
  NOTICE_LIFECYCLE_STATUS,
} from './notice-archive.entity';
import { NoticeArchiveSnapshotState } from './notice-archive-summary-state.entity';
import { NoticeArchiveIntegrityCheck } from './notice-archive-integrity-check.entity';
import { NoticeArchiveIntegrityState } from './notice-archive-integrity-state.entity';
import { NoticeArchiveService } from './notice-archive.service';

describe('summary-backfill ID-page hydration with real SQLite', () => {
  let db: DataSource;
  let service: NoticeArchiveService;
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  beforeEach(async () => {
    queries.length = 0;
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        NoticeArchive,
        NoticeArchiveSnapshotState,
        NoticeArchiveIntegrityCheck,
        NoticeArchiveIntegrityState,
      ],
      migrations,
      logger: {
        logQuery: (sql, parameters) =>
          queries.push({
            sql,
            parameters: Array.isArray(parameters) ? parameters : [],
          }),
        logQueryError() {},
        logQuerySlow() {},
        logSchemaBuild() {},
        logMigration() {},
        log() {},
      },
      logging: ['query'],
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    service = new NoticeArchiveService(
      db.getRepository(NoticeArchive),
      db.getRepository(NoticeArchiveSnapshotState),
      {} as never,
      {} as never,
      db.getRepository(NoticeArchiveIntegrityCheck),
      db.getRepository(NoticeArchiveIntegrityState),
    );
    for (let n = 1; n <= 7; n++) {
      if (n !== 4)
        await db.getRepository(NoticeArchive).save({
          noticeNum: 2200000 + n,
          subject: 'Fixture bill',
          proposerCategory: '의원',
          committee: 'fixture',
          assemblyLink: 'https://example.test',
          proposalReason: 'Fixture proposal reason',
          lifecycleStatus:
            n === 2
              ? NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED
              : n === 3
                ? NOTICE_LIFECYCLE_STATUS.RENUMBERED
                : NOTICE_LIFECYCLE_STATUS.ACTIVE,
        });
      await db.getRepository(NoticeArchiveSnapshotState).save({
        noticeNum: 2200000 + n,
        aiSummaryStatus: 'not_supported',
        isDone: false,
      });
    }
    queries.length = 0;
  });
  afterEach(async () => {
    await db?.destroy();
  });

  it('seeks the unique ID index and excludes inactive and missing archives without shortening the cursor', async () => {
    const page = await (service as any).readSummaryBackfillCursorPage(
      'not_supported',
      0,
      5,
    );
    expect(page.cursorCount).toBe(5);
    expect(page.rows.map((row) => row.num)).toEqual([2200001, 2200005]);
    const statement = queries.find((row) =>
      row.sql.includes('FROM "notice_archives"'),
    );
    expect(statement).toBeDefined();
    expect(statement.sql.split('WHERE')[1]).not.toContain('lifecycle_status');
    const plan = await db.query(
      'EXPLAIN QUERY PLAN ' + statement.sql,
      statement.parameters,
    );
    expect(
      plan.some((row) =>
        /SEARCH .*notice_archives.*noticeNum=\?/i.test(row.detail),
      ),
    ).toBe(true);
    expect(plan.some((row) => row.detail.includes('lifecycle_status=?'))).toBe(
      false,
    );
  });

  it('continues past an inactive page and yields before the next page', async () => {
    let yielded = false;
    const immediate = setImmediate(() => {
      yielded = true;
    });
    try {
      const rows = await service.getNotSupportedSummaryRecoveryPage(0, 5);
      expect(rows.map((row) => row.num)).toEqual([
        2200001, 2200005, 2200006, 2200007,
      ]);
      expect(yielded).toBe(true);
    } finally {
      clearImmediate(immediate);
    }
  });
});
