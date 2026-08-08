import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DataSource } from 'typeorm';

type QueryCase = {
  name: string;
  sql: string;
  params?: unknown[];
};

type QueryMetric = {
  name: string;
  runs: number;
  avgMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  rowCount: number;
};

const backendRoot = path.resolve(__dirname, '..', '..');
const configuredDatabasePath = process.env.DATABASE_PATH?.trim();
const databasePath = configuredDatabasePath
  ? path.isAbsolute(configuredDatabasePath)
    ? configuredDatabasePath
    : path.resolve(backendRoot, configuredDatabasePath)
  : path.resolve(backendRoot, 'lawcast.db');

const runCount = Math.max(
  1,
  Number.parseInt(process.env.DB_PERF_RUNS ?? '10', 10) || 10,
);
const warmupCount = Math.max(
  0,
  Number.parseInt(process.env.DB_PERF_WARMUPS ?? '2', 10) || 2,
);
const optionalMaxMs = Number.parseFloat(process.env.DB_PERF_MAX_MS ?? 'NaN');
const shouldAssertMaxMs = Number.isFinite(optionalMaxMs);

const describePerf = fs.existsSync(databasePath) ? describe : describe.skip;

describePerf('SQLite Query Performance (real DB)', () => {
  let dataSource: DataSource;

  jest.setTimeout(120_000);

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'sqlite',
      database: databasePath,
      synchronize: false,
      migrationsRun: false,
    });

    await dataSource.initialize();

    // Apply the same runtime profile used by the backend service.
    await dataSource.query('PRAGMA journal_mode = WAL;');
    await dataSource.query('PRAGMA synchronous = NORMAL;');
    await dataSource.query('PRAGMA temp_store = MEMORY;');
    await dataSource.query('PRAGMA cache_size = -32768;');
    await dataSource.query('PRAGMA mmap_size = 268435456;');
    await dataSource.query('PRAGMA busy_timeout = 5000;');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('measures representative query latency from the production SQLite file', async () => {
    const [{ cnt: archiveCount }] = await dataSource.query(
      'SELECT COUNT(*) AS cnt FROM notice_archives',
    );
    const [{ cnt: summaryCount }] = await dataSource.query(
      'SELECT COUNT(*) AS cnt FROM notice_archive_snapshot_states',
    );
    const [{ cnt: eventCount }] = await dataSource.query(
      'SELECT COUNT(*) AS cnt FROM notice_change_events',
    );
    const [{ cnt: detailCount }] = await dataSource.query(
      'SELECT COUNT(*) AS cnt FROM notice_change_details',
    );

    expect(Number(archiveCount)).toBeGreaterThan(0);

    const ftsToken = await selectFtsToken(dataSource);

    const queryCases: QueryCase[] = [
      {
        name: 'archive_list_recent',
        sql: `
          SELECT noticeNum, subject, proposerCategory, committee
          FROM notice_archives
          ORDER BY noticeNum DESC
          LIMIT ? OFFSET ?
        `,
        params: [20, 0],
      },
      {
        name: 'archive_list_is_done_exists',
        sql: `
          SELECT archive.noticeNum, archive.subject
          FROM notice_archives archive
          WHERE EXISTS (
            SELECT 1
            FROM notice_archive_snapshot_states summary
            WHERE summary.notice_num = archive.noticeNum
              AND summary.is_done = 0
          )
          ORDER BY archive.noticeNum DESC
          LIMIT ? OFFSET ?
        `,
        params: [20, 0],
      },
      {
        name: 'archive_search_fts',
        sql: `
          SELECT archive.noticeNum, archive.subject
          FROM notice_archives archive
          WHERE archive.rowid IN (
            SELECT rowid
            FROM notice_archives_fts
            WHERE notice_archives_fts MATCH ?
          )
          ORDER BY archive.noticeNum DESC
          LIMIT ? OFFSET ?
        `,
        params: [ftsToken, 20, 0],
      },
      {
        name: 'change_latest_field_value',
        sql: `
          SELECT detail.after_value
          FROM notice_change_details detail
          INNER JOIN notice_change_events event ON event.id = detail.event_id
          WHERE detail.field_path = 'proposalReason'
          ORDER BY event.event_height DESC, detail.id DESC
          LIMIT 1
        `,
      },
    ];

    const metrics: QueryMetric[] = [];

    for (const queryCase of queryCases) {
      const rows = await runQuery(dataSource, queryCase.sql, queryCase.params);
      const rowCount = rows.length;

      const times: number[] = [];
      for (let i = 0; i < warmupCount; i += 1) {
        await runQuery(dataSource, queryCase.sql, queryCase.params);
      }

      for (let i = 0; i < runCount; i += 1) {
        const startedAt = performance.now();
        await runQuery(dataSource, queryCase.sql, queryCase.params);
        times.push(performance.now() - startedAt);
      }

      const sorted = [...times].sort((a, b) => a - b);
      const p95Index = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.95),
      );

      metrics.push({
        name: queryCase.name,
        runs: runCount,
        avgMs: round2(sum(times) / times.length),
        p95Ms: round2(sorted[p95Index]),
        minMs: round2(sorted[0]),
        maxMs: round2(sorted[sorted.length - 1]),
        rowCount,
      });

      // Query should always execute successfully.
      expect(times.length).toBe(runCount);
      expect(sorted[0]).toBeGreaterThanOrEqual(0);
    }

    const explainPlans = await Promise.all(
      queryCases.map(async (queryCase) => ({
        name: queryCase.name,
        rows: await runQuery(
          dataSource,
          `EXPLAIN QUERY PLAN ${queryCase.sql}`,
          queryCase.params,
        ),
      })),
    );

    console.log('\n[DB PERF] databasePath=', databasePath);
    console.log('[DB PERF] tableCounts=', {
      notice_archives: Number(archiveCount),
      notice_archive_snapshot_states: Number(summaryCount),
      notice_change_events: Number(eventCount),
      notice_change_details: Number(detailCount),
    });
    console.table(metrics);

    for (const plan of explainPlans) {
      console.log(`\n[DB PERF][PLAN] ${plan.name}`);
      for (const row of plan.rows as Array<Record<string, unknown>>) {
        console.log(JSON.stringify(row));
      }
    }

    if (shouldAssertMaxMs) {
      for (const metric of metrics) {
        expect(metric.p95Ms).toBeLessThanOrEqual(optionalMaxMs);
      }
    }
  });
});

async function runQuery(
  dataSource: DataSource,
  sql: string,
  params?: unknown[],
): Promise<any[]> {
  if (params && params.length > 0) {
    return dataSource.query(sql, params);
  }
  return dataSource.query(sql);
}

async function selectFtsToken(dataSource: DataSource): Promise<string> {
  const rows = await dataSource.query(`
    SELECT subject
    FROM notice_archives
    WHERE subject IS NOT NULL AND TRIM(subject) != ''
    ORDER BY noticeNum DESC
    LIMIT 200
  `);

  for (const row of rows as Array<{ subject?: string }>) {
    const subject = String(row.subject ?? '').trim();
    const token = extractToken(subject);
    if (token) {
      return `${token}*`;
    }
  }

  return '법률*';
}

function extractToken(input: string): string | null {
  const matches = input.match(/[0-9A-Za-z가-힣_]{2,}/g);
  if (!matches || matches.length === 0) {
    return null;
  }

  const [first] = matches;
  return first?.slice(0, 24) ?? null;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
