const { performance } = require('node:perf_hooks');

/** @typedef {{name: string, sql: string | null}} SchemaRow */
const Database = require('better-sqlite3');

if (!process.send || !process.disconnect) {
  throw new Error('Database dump child requires an IPC channel');
}
const send = process.send.bind(process);
const disconnect = process.disconnect.bind(process);

const legalTables = new Set([
  'notice_archives',
  'notice_archive_snapshot_states',
  'notice_archive_integrity_checks',
  'notice_archive_integrity_states',
  'notice_change_events',
  'notice_change_details',
]);
const shadowSuffixes = new Set(['data', 'idx', 'docsize', 'config', 'content']);
const [sourcePath, dumpPath, dumpFileName, busyTimeoutMs] =
  process.argv.slice(2);

/**
 * @template T
 * @param {'copy' | 'prune' | 'recompact'} phase
 * @param {() => T} work
 * @returns {T}
 */
function measure(phase, work) {
  const context = {
    dumpFileName,
    phase,
    executionContext: 'dump-child',
    pid: process.pid,
  };
  send({ type: 'metric', event: 'db_mirror_phase_start', ...context });
  const rssBeforeBytes = process.memoryUsage.rss();
  const start = performance.now();
  let status = 'error';
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

/** @param {import("better-sqlite3")} db */
function prune(db) {
  db.pragma('foreign_keys = OFF');
  const rows = /** @type {SchemaRow[]} */ (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
  );
  const virtual = new Set(
    rows
      .filter(({ sql }) => /CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? ''))
      .map(({ name }) => name),
  );
  /** @param {string} name */
  const drop = (name) =>
    db.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
  for (const name of virtual) {
    if (!legalTables.has(name)) drop(name);
  }
  for (const { name } of rows) {
    if (legalTables.has(name) || virtual.has(name)) continue;
    // Drop virtual tables before their shadow tables; SQLite owns the latter.
    if (
      [...virtual].some(
        (base) =>
          name.startsWith(base + '_') &&
          shadowSuffixes.has(name.slice(base.length + 1)),
      )
    )
      continue;
    drop(name);
  }
  return rows.map(({ name }) => name).filter((name) => legalTables.has(name));
}

function createDump() {
  measure('copy', () => {
    const source = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
      timeout: Number(busyTimeoutMs),
    });
    try {
      // Keep the copied snapshot durable without changing the live connection's settings.
      source.pragma('synchronous = FULL');
      source.prepare('VACUUM INTO ?').run(dumpPath);
    } finally {
      source.close();
    }
  });

  const dump = new Database(dumpPath, { fileMustExist: true });
  try {
    const retainedTables = measure('prune', () => prune(dump));
    measure('recompact', () => dump.exec('VACUUM'));
    return retainedTables;
  } finally {
    dump.close();
  }
}

let result;
try {
  result = { type: 'result', retainedTables: createDump() };
} catch (error) {
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
