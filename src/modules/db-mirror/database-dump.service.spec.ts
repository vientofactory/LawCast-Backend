import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { DataSource } from 'typeorm';
import Database from 'better-sqlite3';
import { LoggerUtils } from '../../utils/logger.utils';
import { DatabaseDumpService } from './database-dump.service';

describe('DatabaseDumpService', () => {
  let sourceDataSource: DataSource;
  let tempDir: string;
  let sourceDbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lawcast-dump-test-'));
    sourceDbPath = path.join(tempDir, 'source.sqlite');

    sourceDataSource = new DataSource({
      type: 'better-sqlite3',
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

  function createService(dumpDir: string, timeoutMs?: string) {
    return new DatabaseDumpService(
      { get: jest.fn(() => undefined) } as any,
      sourceDataSource,
      {
        get: jest.fn((key: string) =>
          key === 'fileMirror.dumpDir'
            ? dumpDir
            : key === 'FILE_MIRROR_DUMP_TIMEOUT_MS'
              ? timeoutMs
              : undefined,
        ),
      } as any,
    );
  }

  it('prunes non-legal tables without corrupting virtual-table schema', async () => {
    const service = createService(path.join(tempDir, 'dump'));
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
      type: 'better-sqlite3',
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

  it('preserves BLOBs, large integers, sequences, indexes and immutable triggers while excluding private data', async () => {
    await sourceDataSource.query(
      'ALTER TABLE notice_archives ADD COLUMN screenshot_blob BLOB',
    );
    await sourceDataSource.query('CREATE TABLE private_tokens (token TEXT)');
    await sourceDataSource.query(
      "INSERT INTO private_tokens VALUES ('private-sentinel')",
    );
    await sourceDataSource.query(
      "INSERT INTO notice_archives (id, noticeNum, subject, committee, screenshot_blob) VALUES (9007199254740993, 1002, 'Large', 'Committee', ?)",
      [Buffer.from([0, 255, 1, 128])],
    );
    await sourceDataSource.query(
      "UPDATE sqlite_sequence SET seq = 9007199254740999 WHERE name = 'notice_archives'",
    );
    await sourceDataSource.query(
      'CREATE UNIQUE INDEX archive_num_test ON notice_archives (noticeNum)',
    );
    await sourceDataSource.query(
      `CREATE TRIGGER immutable_test BEFORE DELETE ON notice_archives BEGIN SELECT RAISE(ABORT, 'immutable'); END`,
    );
    const artifact = await createService(
      path.join(tempDir, 'dump'),
    ).createSanitizedDump();
    const copy = new Database(artifact.dumpPath, { readonly: true });
    try {
      const row = copy
        .prepare(
          'SELECT id, screenshot_blob FROM notice_archives WHERE noticeNum = 1002',
        )
        .safeIntegers()
        .get() as { id: bigint; screenshot_blob: Buffer };
      expect(row.id).toBe(9007199254740993n);
      expect(row.screenshot_blob).toEqual(Buffer.from([0, 255, 1, 128]));
      expect(
        copy
          .prepare(
            "SELECT seq FROM sqlite_sequence WHERE name = 'notice_archives'",
          )
          .safeIntegers()
          .pluck()
          .get(),
      ).toBe(9007199254740999n);
      expect(
        copy
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('archive_num_test', 'immutable_test') ORDER BY name",
          )
          .all(),
      ).toHaveLength(2);
      expect(
        copy
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name LIKE 'private%' OR name LIKE 'notice_archives_fts%'",
          )
          .all(),
      ).toEqual([]);
      expect(
        (await fs.readFile(artifact.dumpPath)).includes(
          Buffer.from('private-sentinel'),
        ),
      ).toBe(false);
      expect(copy.pragma('foreign_key_check')).toEqual([]);
    } finally {
      copy.close();
    }
    const writable = new Database(artifact.dumpPath);
    try {
      expect(() => writable.exec('DELETE FROM notice_archives')).toThrow(
        'immutable',
      );
    } finally {
      writable.close();
    }
  });

  it('pins every table to one WAL snapshot while a writer commits during copying', async () => {
    await sourceDataSource.query('PRAGMA journal_mode = WAL');
    await sourceDataSource.query(
      'INSERT INTO notice_archive_snapshot_states (notice_num, is_done) VALUES (1001, 0)',
    );
    const writer = new Database(sourceDbPath);
    let committed = false;
    const log = jest
      .spyOn(LoggerUtils, 'log')
      .mockImplementation((context, message) => {
        if (
          context === 'DatabaseMirrorMetrics' &&
          String(message).includes('event=db_mirror_phase_start') &&
          String(message).includes('phase=copy |')
        ) {
          writer.exec(
            "BEGIN IMMEDIATE; UPDATE notice_archives SET subject = 'Changed'; UPDATE notice_archive_snapshot_states SET is_done = 1; COMMIT",
          );
          committed = true;
        }
      });
    try {
      const artifact = await createService(
        path.join(tempDir, 'dump'),
      ).createSanitizedDump();
      expect(committed).toBe(true);
      const copy = new Database(artifact.dumpPath, { readonly: true });
      try {
        expect(
          copy.prepare('SELECT subject FROM notice_archives').pluck().get(),
        ).toBe('테스트 의안');
        expect(
          copy
            .prepare('SELECT is_done FROM notice_archive_snapshot_states')
            .pluck()
            .get(),
        ).toBe(0);
        expect(
          writer.prepare('SELECT subject FROM notice_archives').pluck().get(),
        ).toBe('Changed');
      } finally {
        copy.close();
      }
    } finally {
      log.mockRestore();
      writer.close();
    }
  });

  it('formats parent and child phase logs as readable key-value fields', async () => {
    const log = jest.spyOn(LoggerUtils, 'log').mockImplementation(() => {});
    try {
      const artifact = await createService(
        path.join(tempDir, 'dump'),
      ).createSanitizedDump();
      const lines = log.mock.calls
        .filter(([context]) => context === 'DatabaseMirrorMetrics')
        .map(([, message]) => message as string);
      expect(lines).toHaveLength(8);
      expect(lines[0]).toBe(
        `event=db_mirror_phase_start | dumpFileName=${artifact.dumpFileName} | phase=dump_wait | executionContext=backend-main`,
      );
      expect(lines[7]).toMatch(
        /phase=dump_wait \| executionContext=backend-main \| status=ok .*eventLoopMaxDelayMs=\d+ ms$/,
      );
      expect(lines[1]).toContain(
        `event=db_mirror_phase_start | dumpFileName=${artifact.dumpFileName} | phase=schema | executionContext=dump-child | pid=`,
      );
      expect(lines[2]).toMatch(
        /status=ok \| durationMs=\d+ ms \| rssBeforeBytes=\d+ \(\d+\.\d MiB\) \| rssAfterBytes=\d+ \(\d+\.\d MiB\) \| processRssHighWaterBytes=\d+ \(\d+\.\d MiB\)$/,
      );
    } finally {
      log.mockRestore();
    }
  });

  it('copies committed WAL data without seeing an in-flight writer', async () => {
    await sourceDataSource.query('PRAGMA journal_mode = WAL');
    await sourceDataSource.query(
      "INSERT INTO notice_archives (noticeNum, subject, committee) VALUES (1002, 'Committed', 'Committee')",
    );
    await sourceDataSource.query('BEGIN IMMEDIATE');
    try {
      await sourceDataSource.query(
        "INSERT INTO notice_archives (noticeNum, subject, committee) VALUES (1003, 'Uncommitted', 'Committee')",
      );
      const artifact = await createService(
        path.join(tempDir, "dump's"),
      ).createSanitizedDump();
      const copy = await new DataSource({
        type: 'better-sqlite3',
        database: artifact.dumpPath,
        readonly: true,
      }).initialize();
      try {
        expect(
          await copy.query(
            'SELECT noticeNum FROM notice_archives ORDER BY noticeNum',
          ),
        ).toEqual([{ noticeNum: 1001 }, { noticeNum: 1002 }]);
      } finally {
        await copy.destroy();
      }
    } finally {
      await sourceDataSource.query('ROLLBACK');
    }
  });

  it('rejects overlapping dumps and permits a later run', async () => {
    const service = createService(path.join(tempDir, 'dump'));
    const first = service.createSanitizedDump();
    await expect(service.createSanitizedDump()).rejects.toThrow(
      'already running',
    );
    await service.removeDumpFile((await first).dumpPath);
    await expect(service.createSanitizedDump()).resolves.toMatchObject({
      retainedTables: expect.arrayContaining(['notice_archives']),
    });
  });

  it('cleans the reserved file on shutdown and refuses new dumps', async () => {
    const dumpDir = path.join(tempDir, 'dump');
    const service = createService(dumpDir);
    const result = expect(service.createSanitizedDump()).rejects.toMatchObject({
      code: 'DUMP_CHILD_CANCELLED',
    });
    await service.onModuleDestroy();
    await result;
    expect(await fs.readdir(dumpDir)).toEqual([]);
    await expect(service.createSanitizedDump()).rejects.toThrow(
      'shutting down',
    );
  });

  it('cleans a timed-out dump and can retry once the SQLite lock is released', async () => {
    const dumpDir = path.join(tempDir, 'dump');
    const service = createService(dumpDir, '500');
    await sourceDataSource.query('PRAGMA journal_mode = DELETE');
    await sourceDataSource.query('BEGIN EXCLUSIVE');
    try {
      await expect(service.createSanitizedDump()).rejects.toMatchObject({
        code: 'DUMP_CHILD_TIMEOUT',
      });
      expect(await fs.readdir(dumpDir)).toEqual([]);
    } finally {
      await sourceDataSource.query('ROLLBACK');
    }
    await expect(service.createSanitizedDump()).resolves.toMatchObject({
      retainedTables: expect.arrayContaining(['notice_archives']),
    });
  });

  it('removes the reserved file after a failed child run', async () => {
    await sourceDataSource.destroy();
    await fs.rm(sourceDbPath);
    const dumpDir = path.join(tempDir, 'dump');
    await expect(
      createService(dumpDir).createSanitizedDump(),
    ).rejects.toMatchObject({
      code: 'SQLITE_CANTOPEN',
    });
    expect(await fs.readdir(dumpDir)).toEqual([]);
  });
});
