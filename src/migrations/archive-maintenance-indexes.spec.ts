import { DataSource } from 'typeorm';
import { migrations } from './index';
import { OptimizeArchiveMaintenanceIndexes1795651201000 } from './202611260001-optimize-archive-maintenance-indexes.migration';
import { NoticeArchive } from '../modules/notice/notice-archive.entity';
import { NoticeArchiveSnapshotState } from '../modules/notice/notice-archive-summary-state.entity';
import { NoticeArchiveService } from '../modules/notice/notice-archive.service';
import { APP_CONSTANTS } from '../config/app.config';

describe('Archive maintenance index migration', () => {
  let db: DataSource;
  let service: NoticeArchiveService;
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];

  beforeEach(async () => {
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [NoticeArchive, NoticeArchiveSnapshotState],
      migrations: migrations.filter(
        (migration) =>
          migration !== OptimizeArchiveMaintenanceIndexes1795651201000,
      ),
      logging: ['query'],
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
    });
    await db.initialize();
    await db.runMigrations();
    const floor = APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM;
    for (let i = 0; i < 12; i++) {
      await db.getRepository(NoticeArchive).save({
        noticeNum: i === 0 ? floor - 1 : floor + i,
        subject: `Fixture ${i}`,
        proposerCategory: '의원',
        committee: 'Fixture committee',
        assemblyLink: 'https://example.test',
        proposalReason: i % 3 === 0 ? 'Reason' : i % 3 === 1 ? '' : '  ',
        contentId: i % 2 === 0 ? `PAL_${i}` : null,
        sourceHtml: i < 6 ? null : 'Fixture HTML',
        screenshotBlob: i < 8 ? null : Buffer.from('image'),
        lifecycleStatus:
          i === 3 ? 'source_deleted' : i === 4 ? 'renumbered' : 'active',
        proposalReasonRetryCount: i % 2,
        proposalReasonRetriedAt: i % 2 ? new Date('2026-11-25') : null,
      });
    }
    await db.getRepository(NoticeArchiveSnapshotState).save({
      noticeNum: floor + 1,
      isDone: true,
      aiSummaryStatus: 'not_supported',
    });
    // A historical reason and deletion still exclude candidates regardless of indexes.
    await db.query(
      `INSERT INTO notice_change_events
       (notice_num,event_height,event_type,event_hash,detected_at)
       VALUES (?, 1, 'updated', 'history', '2026-11-25')`,
      [floor + 2],
    );
    await db.query(
      `INSERT INTO notice_change_details (event_id,field_path,after_value,change_type)
       SELECT id, 'proposalReason', 'historical reason', 'modified'
       FROM notice_change_events WHERE event_hash = 'history'`,
    );
    service = new NoticeArchiveService(
      db.getRepository(NoticeArchive),
      db.getRepository(NoticeArchiveSnapshotState),
      { getLatestFieldValues: async () => new Map() } as never,
      {} as never,
      undefined as never,
      undefined as never,
    );
  });

  afterEach(async () => db?.destroy());

  async function readCandidates() {
    return {
      pal: await service.getNoticesWithMissingScreenshots(2),
      nsm: await service.getNoticesWithMissingNsmScreenshots(2),
      html: await service.getNoticesWithMissingSnapshotArtifacts(2),
      retry: await service.getProposalReasonRetryCandidates(20),
    };
  }

  it('preserves candidates, ordering, payloads, rows and triggers through up/down/up', async () => {
    const baseline = await readCandidates();
    const rows = await db.query(
      'SELECT * FROM notice_archives ORDER BY noticeNum',
    );
    const triggers = await db.query(
      "SELECT name,sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    );
    const indexSql = () =>
      db.query(
        "SELECT name,sql FROM sqlite_master WHERE type = 'index' ORDER BY name",
      );
    const beforeIndexes = await indexSql();
    const migration = new OptimizeArchiveMaintenanceIndexes1795651201000();
    const runner = db.createQueryRunner();
    await migration.up(runner);
    queries.length = 0;
    expect(await readCandidates()).toEqual(baseline);
    const candidateQueries = queries.filter(
      ({ sql }) =>
        sql.startsWith('SELECT') && sql.includes('FROM "notice_archives"'),
    );
    expect(candidateQueries).toHaveLength(5);
    for (const query of candidateQueries) {
      const plan: Array<{ detail: string }> = await db.query(
        'EXPLAIN QUERY PLAN ' + query.sql,
        query.parameters,
      );
      const text = plan.map((row) => row.detail).join('\n');
      expect(text).not.toContain('USE TEMP B-TREE FOR ORDER BY');
      expect(text).toMatch(
        /USING INDEX idx_notice_archives_(missing_|reason_retry_queue)/,
      );
    }
    expect(
      await db.query('SELECT * FROM notice_archives ORDER BY noticeNum'),
    ).toEqual(rows);
    expect(
      await db.query(
        "SELECT name,sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      ),
    ).toEqual(triggers);
    await migration.down(runner);
    expect(await readCandidates()).toEqual(baseline);
    const normalize = (entries: Array<{ name: string; sql: string | null }>) =>
      entries.map(({ name, sql }) => ({
        name,
        sql: sql?.replace(/\s+/g, ' ').trim(),
      }));
    expect(normalize(await indexSql())).toEqual(normalize(beforeIndexes));
    await migration.up(runner);
    expect(await readCandidates()).toEqual(baseline);
    expect(await db.query('PRAGMA integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
    await runner.release();
  });
});
