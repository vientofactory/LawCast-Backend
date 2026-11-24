import { performance } from 'node:perf_hooks';
import { constants, setPriority } from 'node:os';
import Database from 'better-sqlite3';
import { type MirrorMetricFields } from './mirror-phase-metrics';

interface SchemaRow {
  name: string;
  type: string;
  tbl_name: string;
  sql: string | null;
}

type DumpChildResult =
  | { type: 'result'; retainedTables: string[] }
  | { type: 'failure'; message: string; code?: string };
type DumpChildMessage =
  DumpChildResult | ({ type: 'metric' } & MirrorMetricFields);

if (!process.send || !process.disconnect) {
  throw new Error('Database dump child requires an IPC channel');
}
const send: (message: DumpChildMessage, callback?: () => void) => boolean =
  process.send.bind(process);
const disconnect = process.disconnect.bind(process);

const legalTables = new Set([
  'notice_archives',
  'notice_archive_snapshot_states',
  'notice_archive_integrity_checks',
  'notice_archive_integrity_states',
  'notice_change_events',
  'notice_change_details',
]);
const [sourcePath, dumpPath, dumpFileName, busyTimeoutMs] =
  process.argv.slice(2);

function measure<T>(phase: 'schema' | 'copy' | 'indexes', work: () => T): T {
  const context = {
    dumpFileName,
    phase,
    executionContext: 'dump-child',
    pid: process.pid,
  };
  send({ type: 'metric', event: 'db_mirror_phase_start', ...context });
  const rssBeforeBytes = process.memoryUsage.rss();
  const start = performance.now();
  let status: 'ok' | 'error' = 'error';
  try {
    const result = work();
    status = 'ok';
    return result;
  } finally {
    send({
      type: 'metric',
      event: 'db_mirror_phase_finish',
      ...context,
      status,
      durationMs: Math.round(performance.now() - start),
      rssBeforeBytes,
      rssAfterBytes: process.memoryUsage.rss(),
      processRssHighWaterBytes: process.resourceUsage().maxRSS * 1024,
    });
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function createDump(): string[] {
  // Native SQLite allocations are outside V8's heap limit. Bound both page caches,
  // disable mmap, and spill index sorting to disk instead of competing with the API.
  if (process.platform === 'linux') {
    setPriority(0, constants.priority.PRIORITY_LOW);
  }
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
    timeout: Number(busyTimeoutMs),
  });
  let dump: Database | undefined;
  try {
    dump = new Database(dumpPath, {
      fileMustExist: true,
      timeout: Number(busyTimeoutMs),
    });
    dump.pragma('journal_mode = DELETE');
    dump.pragma('synchronous = FULL');
    dump.pragma('cache_size = -8192');
    dump.pragma('mmap_size = 0');
    dump.pragma('temp_store = FILE');
    dump.pragma('threads = 1');
    source.pragma('cache_size = -8192');
    source.pragma('mmap_size = 0');
    source.pragma('temp_store = FILE');
    source.exec('BEGIN');
    dump.pragma('foreign_keys = OFF');

    // One read transaction pins schema, all six tables and sequence values to the
    // same committed WAL snapshot. Stream one row at a time, including BLOBs.
    return dump.transaction(() => {
      const schema = measure('schema', () => {
        const rows = source
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')",
          )
          .all() as SchemaRow[];
        const retained = rows.filter((row) => legalTables.has(row.tbl_name));
        const tables = retained.filter((row) => row.type === 'table');
        if (
          tables.some((row) => /CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? ''))
        ) {
          throw new Error('Mirror allowlist must contain ordinary tables only');
        }
        for (const row of tables) dump.exec(row.sql!);
        return {
          retained,
          tables,
          userVersion: source.pragma('user_version', { simple: true }),
          applicationId: source.pragma('application_id', { simple: true }),
        };
      });
      measure('copy', () => {
        for (const { name } of schema.tables) {
          // Generated columns are recomputed by SQLite, not written explicitly.
          const columns = (
            source.pragma(`table_xinfo(${quote(name)})`) as {
              name: string;
              hidden: number;
            }[]
          )
            .filter((column) => column.hidden === 0)
            .map((column) => quote(column.name));
          const insert = dump.prepare(
            `INSERT INTO ${quote(name)} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(',')})`,
          );
          for (const row of source
            .prepare(`SELECT ${columns.join(', ')} FROM ${quote(name)}`)
            .raw()
            .safeIntegers()
            .iterate()) {
            insert.run(
              ...(row as (string | number | bigint | Buffer | null)[]),
            );
          }
        }
        const hasSequences = source
          .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'")
          .get();
        if (
          hasSequences &&
          schema.tables.length > 0 &&
          dump
            .prepare(
              "SELECT 1 FROM main.sqlite_schema WHERE name = 'sqlite_sequence'",
            )
            .get()
        ) {
          // Preserve high-water IDs even when the last allocated row was deleted.
          dump.exec('DELETE FROM main.sqlite_sequence');
          const names = schema.tables.map(({ name }) => name);
          const insertSequence = dump.prepare(
            'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)',
          );
          const sequences = source
            .prepare(
              `SELECT name, seq FROM sqlite_sequence WHERE name IN (${names.map(() => '?').join(',')})`,
            )
            .raw()
            .safeIntegers()
            .all(...names);
          for (const row of sequences)
            insertSequence.run(
              ...(row as (string | number | bigint | Buffer | null)[]),
            );
        }
      });
      // Release the live WAL snapshot before sorting indexes on the detached copy.
      source.exec('COMMIT');
      measure('indexes', () => {
        // Restore triggers only after loading data, preserving immutable history
        // without firing FTS triggers whose private virtual tables are excluded.
        for (const row of schema.retained) {
          if (row.type !== 'table') dump.exec(row.sql!);
        }
        dump.pragma(`user_version = ${schema.userVersion}`);
        dump.pragma(`application_id = ${schema.applicationId}`);
      });
      return schema.tables.map(({ name }) => name);
    })();
  } finally {
    dump?.close();
    source.close();
  }
}

let result: DumpChildResult;
try {
  result = { type: 'result', retainedTables: createDump() };
} catch (error: unknown) {
  process.exitCode = 1;
  result = {
    type: 'failure',
    message: error instanceof Error ? error.message : String(error),
    code:
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined,
  };
}
send(result, () => disconnect());
