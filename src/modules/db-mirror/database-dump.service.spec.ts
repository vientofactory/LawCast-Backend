import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DataSource } from 'typeorm';
import { DatabaseDumpService } from './database-dump.service';

describe('DatabaseDumpService', () => {
  let sourceDataSource: DataSource;
  let tempDir: string;
  let sourceDbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lawcast-dump-test-'));
    sourceDbPath = path.join(tempDir, 'source.sqlite');

    sourceDataSource = new DataSource({
      type: 'sqlite',
      database: sourceDbPath,
      entities: [],
      synchronize: false,
    });
    await sourceDataSource.initialize();

    await sourceDataSource.query(`
      CREATE TABLE IF NOT EXISTS notice_archives (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        noticeNum integer NOT NULL,
        subject text NOT NULL,
        committee text NOT NULL,
        proposalReason text
      )
    `);
    await sourceDataSource.query(`
      CREATE TABLE IF NOT EXISTS notice_archive_snapshot_states (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        notice_num integer NOT NULL,
        is_done boolean NOT NULL DEFAULT (0)
      )
    `);
    await sourceDataSource.query(`
      CREATE TABLE IF NOT EXISTS notice_archive_integrity_checks (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        notice_num integer NOT NULL
      )
    `);
    await sourceDataSource.query(`
      CREATE TABLE IF NOT EXISTS notice_archive_integrity_states (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        notice_num integer NOT NULL
      )
    `);
    await sourceDataSource.query(`
      CREATE TABLE IF NOT EXISTS notice_change_events (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        notice_num integer NOT NULL
      )
    `);
    await sourceDataSource.query(`
      CREATE TABLE IF NOT EXISTS notice_change_details (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        event_id integer NOT NULL
      )
    `);

    await sourceDataSource.query(`
      INSERT INTO notice_archives (noticeNum, subject, committee, proposalReason)
      VALUES (1001, '테스트 의안', '법제사법위원회', '테스트 제안 이유')
    `);

    await sourceDataSource.query(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notice_archives_fts
      USING fts5(
        subject,
        committee,
        proposalReason,
        content='notice_archives',
        content_rowid='rowid',
        tokenize='unicode61'
      )
    `);
    await sourceDataSource.query(
      `INSERT INTO notice_archives_fts (notice_archives_fts) VALUES ('rebuild')`,
    );
  });

  afterEach(async () => {
    if (sourceDataSource?.isInitialized) {
      await sourceDataSource.destroy();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('prunes non-legal tables without corrupting virtual-table schema', async () => {
    const dumpDir = path.join(tempDir, 'dump');
    const configServiceMock = {
      get: jest.fn((key: string) => {
        if (key === 'fileMirror.dumpDir') {
          return dumpDir;
        }
        return undefined;
      }),
    };

    const moduleRefMock = {
      get: jest.fn(() => undefined),
    };

    const service = new DatabaseDumpService(
      moduleRefMock as any,
      sourceDataSource,
      configServiceMock as any,
    );

    const artifact = await service.createSanitizedDump();

    expect(artifact.retainedTables).toEqual(
      expect.arrayContaining([
        'notice_archives',
        'notice_archive_snapshot_states',
        'notice_archive_integrity_checks',
        'notice_archive_integrity_states',
        'notice_change_events',
        'notice_change_details',
      ]),
    );

    const dumpDataSource = new DataSource({
      type: 'sqlite',
      database: artifact.dumpPath,
      entities: [],
      synchronize: false,
    });
    await dumpDataSource.initialize();

    try {
      const integrity = await dumpDataSource.query('PRAGMA integrity_check;');
      expect(String(integrity?.[0]?.integrity_check ?? '').toLowerCase()).toBe(
        'ok',
      );

      const ftsTables = await dumpDataSource.query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name LIKE 'notice_archives_fts%'
      `);
      expect(ftsTables).toHaveLength(0);

      const rows = await dumpDataSource.query(
        'SELECT COUNT(*) AS cnt FROM notice_archives;',
      );
      expect(Number(rows?.[0]?.cnt ?? 0)).toBe(1);
    } finally {
      await dumpDataSource.destroy();
    }
  });
});
