import { DataSource } from 'typeorm';
import { migrations } from '../../migrations';
import { ChangeTrackingService } from './change-tracking.service';
import { NoticeChangeEvent } from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';

describe('Latest field lookup scope on the complete SQLite schema', () => {
  let db: DataSource;
  let service: ChangeTrackingService;
  let queries: Array<{ sql: string; parameters: unknown[] }> = [];

  beforeAll(async () => {
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [NoticeChangeEvent, NoticeChangeDetail],
      migrations,
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
    for (const [id, num, height] of [
      [1, 1, 2],
      [2, 1, 1],
      [3, 2, 1],
    ]) {
      await db.query(
        `INSERT INTO notice_change_events (id,notice_num,event_height,event_type,event_hash,detected_at)
         VALUES (?, ?, ?, 'updated', ?, '2026-11-26 00:00:00')`,
        [id, num, height, String(id).padStart(64, '0')],
      );
    }
    for (const [eventId, field, value] of [
      [2, 'proposalReason', 'old reason'],
      [1, 'proposalReason', 'superseded in the same event'],
      [1, 'proposalReason', null],
      [2, 'subject', 'old subject'],
      [1, 'subject', '  new subject\n  '],
      [1, 'contentId', '   '],
      [3, 'proposalReason', 'other notice'],
    ]) {
      await db.query(
        `INSERT INTO notice_change_details
         (event_id,field_path,change_type,after_value) VALUES (?, ?, 'modified', ?)`,
        [eventId, field, value],
      );
    }
  });

  beforeEach(() => {
    queries = [];
    service = new ChangeTrackingService(
      db.getRepository(NoticeChangeEvent),
      db.getRepository(NoticeChangeDetail),
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(async () => db?.destroy());

  async function expectScopedPlans() {
    expect(queries.length).toBeGreaterThan(0);
    for (const query of [...queries]) {
      const plan: Array<{ detail: string }> = await db.query(
        'EXPLAIN QUERY PLAN ' + query.sql,
        query.parameters,
      );
      const text = plan.map((row) => row.detail).join('\n');
      expect(text).toMatch(
        /SEARCH (?:event|notice_change_events).*notice_num=\?/,
      );
      expect(text).toMatch(/SEARCH detail.*event_id=\? AND field_path=\?/);
      expect(text).not.toMatch(/SEARCH detail.*\(field_path=\?\)/);
    }
  }

  it('preserves height, detail ID, null clears, nonempty history and whitespace semantics', async () => {
    expect(await service.getLatestFieldValue(1, 'proposalReason')).toBeNull();
    expect(await service.getLatestFieldAfterValue(1, 'proposalReason')).toBe(
      'superseded in the same event',
    );
    expect(await service.getLatestFieldValue(1, 'subject')).toBe('new subject');
    expect(await service.getLatestFieldValue(1, 'contentId')).toBeNull();
    expect(await service.getLatestFieldValue(1, 'missing')).toBeNull();
    expect(await service.getLatestFieldValue(999, 'subject')).toBeNull();
    await expectScopedPlans();
  });

  it('bounds both batch APIs and distinguishes missing fields from explicit clears', async () => {
    const nums = [...Array.from({ length: 401 }, (_, index) => index + 1), 1];
    const singleField = await service.getLatestFieldValues(nums, 'subject');
    expect(singleField.size).toBe(401);
    expect(singleField.get(1)).toBe('new subject');
    expect(singleField.get(2)).toBeNull();
    expect(queries).toHaveLength(3);
    const multiField = await service.getLatestFieldValuesForFields(nums, [
      'subject',
      'proposalReason',
      'contentId',
      'missing',
      'subject',
    ]);
    expect(queries).toHaveLength(6);
    expect(multiField.get(1)?.get('subject')).toBe('  new subject\n  ');
    expect(multiField.get(1)?.has('proposalReason')).toBe(true);
    expect(multiField.get(1)?.get('proposalReason')).toBeNull();
    expect(multiField.get(1)?.get('contentId')).toBe('   ');
    expect(multiField.get(1)?.has('missing')).toBe(false);
    expect(multiField.has(401)).toBe(false);
    await expectScopedPlans();
  });

  it('avoids queries for empty inputs and binds unusual field strings as values', async () => {
    expect(await service.getLatestFieldValues([], 'subject')).toEqual(
      new Map(),
    );
    expect(await service.getLatestFieldValuesForFields([1], [])).toEqual(
      new Map(),
    );
    expect(queries).toHaveLength(0);
    expect(await service.getLatestFieldValue(1, "' OR 1=1 --")).toBeNull();
    await expectScopedPlans();
  });

  it('retains the single-field batch fallback when the bulk query fails', async () => {
    const bulk = jest
      .spyOn(service, 'getLatestFieldValuesForFields')
      .mockRejectedValueOnce(new Error('bulk unavailable'));
    expect(await service.getLatestFieldValues([1, 2, 1], 'subject')).toEqual(
      new Map([
        [1, 'new subject'],
        [2, null],
      ]),
    );
    bulk.mockRestore();
    await expectScopedPlans();
  });
});
