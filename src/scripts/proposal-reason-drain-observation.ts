import { readFileSync } from 'node:fs';
import { Database } from 'sqlite3';
import { APP_CONSTANTS } from '../config/app.config';

/**
 * Tick-level observer for the `proposalReason` drain backlog.
 *
 * The drain runs from a 15-minute cron trigger. Its health is not "did a pass
 * happen" but "did the 15-minute ticks move the pool": a pass that re-seeds the
 * same page every time looks identical to progress in aggregate counters, which
 * is how a frozen backlog stayed invisible in production
 * (agent_memories/39-likms-reason-backfill-throughput/). This reporter turns
 * one observation window into the per-tick series that distinguishes the two,
 * and exits non-zero when the window shows no burn-down so it can gate a
 * verification run.
 *
 * Two independent sources, because neither alone is enough:
 * - the database holds the pool state and the attempt stamps (the mechanism the
 *   drain's cursor advances on);
 * - the container log lines hold what each tick actually did (ran / deferred /
 *   skipped, how many rows it seeded, how many attempts it stamped). Per-tick
 *   attempt counts come from the log, because the DB column keeps only the most
 *   recent attempt per row - it can attribute a row to its latest tick, not to
 *   every tick it appeared in.
 *
 * Usage inside the deployment container (dist/scripts/... after `npm run build`):
 *
 *   docker logs lawcast-backend --since 6h 2>&1 | \
 *     docker exec -i lawcast-backend node dist/scripts/proposal-reason-drain-observation.js \
 *       --db "$DATABASE_PATH" --logs - --ticks 16
 *
 * The container runs with `TZ=Asia/Seoul`, so log timestamps are local while the
 * database stores UTC; `--log-utc-offset` (default 540 = KST) bridges them.
 */

/** Cron fields are read from the same constant the scheduler registers. */
const TICK_CRON_EXPRESSION =
  APP_CONSTANTS.CRON.EXPRESSIONS.PROPOSAL_REASON_BACKFILL_DRAIN;

/** Rows the drain seeds per tick, from the constant the cron uses. */
export const SEED_LIMIT =
  APP_CONSTANTS.ARCHIVE_SYNC.SUMMARY_BACKFILL_BATCH_SIZE;

/**
 * Lowest notice number the drain can seed, from the constant the candidate
 * query filters on. The pool below this floor is out of scope for the backfill
 * (bills from earlier Assemblies, whose sources publish no detail page), so
 * including it here would report a backlog the drain is not supposed to work
 * through.
 */
export const POOL_MIN_NOTICE_NUM =
  APP_CONSTANTS.ARCHIVE_SYNC.BACKFILL_MIN_NOTICE_NUM;

/** One cron interval, used for tick bucketing and the cost budget check. */
export const DEFAULT_TICK_STEP_MINUTES = 15;

const ISO_TICK_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const NEST_LOG_PATTERN =
  /^\[Nest\]\s+\d+\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\s*(?:LOG|WARN|ERROR|DEBUG|VERBOSE|FATAL)\s*\[([^\]]*)\]\s?(.*)$/i;
/**
 * `docker logs` keeps the terminal's color escapes, which sit between the log
 * header and the message. The ESC byte is written as its code point so the
 * source carries no raw control byte.
 */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Log lines the drain and its tick owner emit. Kept next to the reporter so the
 * procedure document, the parsing tests and this script cannot drift apart.
 */
export const DRAIN_LOG_PATTERNS = {
  seeded:
    /proposalReason retry cron: queue before=(\d+), seeded=(\d+), queue after seed=(\d+)/,
  completed:
    /proposalReason retry cron: drain completed, queue after drain=(\d+)/,
  deferred:
    /proposalReason retry cron: deferred this tick - (.+?) held the browser for (\d+)ms/,
  waited:
    /proposalReason retry cron: browser freed after (\d+)ms, draining now/,
  attemptsRecorded:
    /proposalReason retry: recorded (\d+) attempt\(s\) for candidate rotation/,
  billResolved:
    /proposalReason retry: resolved bill (\S+) after (\d+) attempt\(s\)/,
  archiveSyncSkip: /proposalReason NSM reason drain skipped - (.+)/,
  summaryBackfillPass: /Summary backfill staged - scanned=/,
} as const;

export type DrainTickStatus =
  'ran' | 'deferred' | 'archive-sync-deferred' | 'no tick log';

export interface TickGrid {
  anchorMinute: number;
  stepMinutes: number;
}

export interface DrainLogEvent {
  at: Date;
  tickStart: Date;
  kind:
    | 'tick-seeded'
    | 'drain-completed'
    | 'drain-deferred'
    | 'drain-waited'
    | 'attempts-recorded'
    | 'bill-resolved'
    | 'drain-skipped'
    | 'summary-backfill-pass';
  seeded?: number;
  queueBefore?: number;
  queueAfterSeed?: number;
  queueAfterDrain?: number;
  waitedMs?: number;
  blockers?: string[];
  attemptsRecorded?: number;
  billNo?: string;
}

export interface ReasonArrival {
  at: Date;
  noticeNum: number;
  contentIdPresent: boolean;
}

export interface PoolSummary {
  total: number;
  contentIdNull: number;
  realTargets: number;
}

export interface StuckRow {
  noticeNum: number;
  retryCount: number;
  contentIdPresent: boolean;
}

export interface DbFacts {
  poolQueryMs: number;
  poolSummary: PoolSummary | null;
  trackingColumnsPresent: boolean;
  reasonArrivals: ReasonArrival[];
  attemptStamps: Array<{
    noticeNum: number;
    retryCount: number;
    retriedAt: Date | null;
    contentIdPresent: boolean;
  }>;
  coverage: { attempted: number; neverAttempted: number } | null;
  stuckRows: StuckRow[];
}

export interface TickFacts {
  tickStartIso: string;
  status: DrainTickStatus;
  blockers: string[];
  waitedMs: number | null;
  seeded: number | null;
  attemptsRecordedFromLog: number | null;
  resolvedBills: number;
  queueAfterDrain: number | null;
  summaryBackfillRan: boolean;
  attemptsStampedInWindow: number | null;
  recoverableAttemptsInWindow: number | null;
  arrivalsInWindow: number;
  poolEstimateAtEnd: number | null;
  realTargetsEstimateAtEnd: number | null;
}

export interface Verdict {
  id: string;
  label: string;
  level: 'pass' | 'fail' | 'warn' | 'skip';
  detail: string;
}

export interface DrainObservationReport {
  databasePath: string;
  generatedAtIso: string;
  logUtcOffsetMinutes: number;
  tickGrid: TickGrid;
  window: { fromIso: string; toIso: string };
  poolQueryMs: number;
  poolSummary: PoolSummary | null;
  trackingColumnsPresent: boolean;
  coverage: { attempted: number; neverAttempted: number } | null;
  stuckRows: StuckRow[];
  realTargetArrivals: number;
  /** Rows with a recoverable source that were attempted inside the window. */
  recoverableRowsAttempted: number;
  /**
   * Rows whose latest attempt stamp falls inside the window. Comparing it with
   * the log's per-tick attempt counts is what exposes a pinned cursor: a wedged
   * drain burns many attempts on a handful of rows, a rotating one spends each
   * attempt on a row it had not reached yet.
   */
  distinctRowsAttempted: number;
  replayedTicks: number;
  unparsedLogLines: number;
  ticks: TickFacts[];
  verdicts: Verdict[];
}

/**
 * Reads the anchor minute and step of the 15-minute drain trigger out of its
 * cron expression, so the ticks this reporter buckets by are the ticks the
 * scheduler fires (`9-59/15` -> every 15 minutes starting at minute 9).
 */
export function parseTickGrid(expression: string): TickGrid {
  const minuteField = expression.trim().split(/\s+/)[0] ?? '';
  const range = /^(\d{1,2})-(\d{1,2})\/(\d{1,2})$/.exec(minuteField);
  if (range) {
    return {
      anchorMinute: Number(range[1]),
      stepMinutes: Number(range[3]),
    };
  }

  const step = /^\*\/(\d{1,2})$/.exec(minuteField);
  if (step) {
    return { anchorMinute: 0, stepMinutes: Number(step[1]) };
  }

  return { anchorMinute: 9, stepMinutes: DEFAULT_TICK_STEP_MINUTES };
}

/**
 * Start of the tick window the given instant belongs to.
 *
 * A tick that fires at :54 owns the following minutes until the next tick at
 * :09, so an event at :05 belongs to the previous hour's :54 window.
 */
export function tickStartFor(date: Date, grid: TickGrid): Date {
  const step = Math.max(1, grid.stepMinutes);
  const minutesIntoHour = date.getUTCHours() * 60 + date.getUTCMinutes();
  const tickIndex = Math.floor((minutesIntoHour - grid.anchorMinute) / step);

  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) +
      (grid.anchorMinute + tickIndex * step) * 60_000,
  );
}

export function toTickKey(date: Date, grid: TickGrid): string {
  return tickStartFor(date, grid).toISOString();
}

/**
 * Parses a Nest log header timestamp into a UTC instant.
 *
 * The container prints local time (`TZ=Asia/Seoul`) while SQLite stores UTC, so
 * the offset has to be subtracted explicitly - `new Date(...)` on this format is
 * locale-dependent and would silently disagree with the database.
 */
export function parseNestLogTimestamp(
  line: string,
  logUtcOffsetMinutes: number,
): { at: Date; message: string } | null {
  const match = NEST_LOG_PATTERN.exec(line.replace(ANSI_PATTERN, ''));
  if (!match) {
    return null;
  }

  const [, month, day, year, hourText, minute, second, meridiem, , message] =
    match;
  const hour12 = Number(hourText) % 12;
  const hour = meridiem.toUpperCase() === 'PM' ? hour12 + 12 : hour12;

  const at = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      hour,
      Number(minute),
      Number(second),
    ) -
      logUtcOffsetMinutes * 60_000,
  );

  return { at, message: message ?? '' };
}

/**
 * Turns log lines into per-tick facts. Lines that do not carry a drain signal
 * are ignored; lines that match no timestamp are counted so a wrong
 * `--log-utc-offset` or log format shows up instead of producing empty ticks.
 */
export function parseDrainLogEvents(
  lines: Iterable<string>,
  grid: TickGrid,
  logUtcOffsetMinutes: number,
): { events: DrainLogEvent[]; unparsedLines: number } {
  const events: DrainLogEvent[] = [];
  let unparsedLines = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const parsed = parseNestLogTimestamp(line, logUtcOffsetMinutes);
    if (!parsed) {
      if (ISO_TICK_PATTERN.test(line) || line.includes('-')) {
        unparsedLines += 1;
      }
      continue;
    }

    const { at, message } = parsed;
    const tickStart = tickStartFor(at, grid);
    const base = { at, tickStart };

    const seeded = DRAIN_LOG_PATTERNS.seeded.exec(message);
    if (seeded) {
      events.push({
        ...base,
        kind: 'tick-seeded',
        queueBefore: Number(seeded[1]),
        seeded: Number(seeded[2]),
        queueAfterSeed: Number(seeded[3]),
      });
      continue;
    }

    const completed = DRAIN_LOG_PATTERNS.completed.exec(message);
    if (completed) {
      events.push({
        ...base,
        kind: 'drain-completed',
        queueAfterDrain: Number(completed[1]),
      });
      continue;
    }

    const deferred = DRAIN_LOG_PATTERNS.deferred.exec(message);
    if (deferred) {
      events.push({
        ...base,
        kind: 'drain-deferred',
        blockers: deferred[1].split(',').map((name) => name.trim()),
        waitedMs: Number(deferred[2]),
      });
      continue;
    }

    const waited = DRAIN_LOG_PATTERNS.waited.exec(message);
    if (waited) {
      events.push({
        ...base,
        kind: 'drain-waited',
        waitedMs: Number(waited[1]),
      });
      continue;
    }

    const attempts = DRAIN_LOG_PATTERNS.attemptsRecorded.exec(message);
    if (attempts) {
      events.push({
        ...base,
        kind: 'attempts-recorded',
        attemptsRecorded: Number(attempts[1]),
      });
      continue;
    }

    const resolved = DRAIN_LOG_PATTERNS.billResolved.exec(message);
    if (resolved) {
      events.push({ ...base, kind: 'bill-resolved', billNo: resolved[1] });
      continue;
    }

    const skip = DRAIN_LOG_PATTERNS.archiveSyncSkip.exec(message);
    if (skip) {
      events.push({
        ...base,
        kind: 'drain-skipped',
        blockers: [skip[1].trim()],
      });
      continue;
    }

    if (DRAIN_LOG_PATTERNS.summaryBackfillPass.test(message)) {
      events.push({ ...base, kind: 'summary-backfill-pass' });
    }
  }

  return { events, unparsedLines };
}

/** Collapses log events into the tick they belong to. */
export function summarizeTicks(
  events: DrainLogEvent[],
  tickStarts: Date[],
): Map<
  string,
  Omit<
    TickFacts,
    | 'attemptsStampedInWindow'
    | 'arrivalsInWindow'
    | 'poolEstimateAtEnd'
    | 'realTargetsEstimateAtEnd'
  >
> {
  const byTick = new Map<
    string,
    Omit<
      TickFacts,
      | 'attemptsStampedInWindow'
      | 'arrivalsInWindow'
      | 'poolEstimateAtEnd'
      | 'realTargetsEstimateAtEnd'
    >
  >();

  for (const tickStart of tickStarts) {
    byTick.set(tickStart.toISOString(), {
      tickStartIso: tickStart.toISOString(),
      status: 'no tick log',
      blockers: [],
      waitedMs: null,
      seeded: null,
      attemptsRecordedFromLog: null,
      resolvedBills: 0,
      queueAfterDrain: null,
      summaryBackfillRan: false,
      recoverableAttemptsInWindow: null,
    });
  }

  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());

  for (const event of sorted) {
    const key = event.tickStart.toISOString();
    const fact = byTick.get(key);
    if (!fact) {
      continue;
    }

    switch (event.kind) {
      case 'tick-seeded':
        // The seeding line only prints after a browser window was obtained, so
        // it is the unambiguous "this tick drained" signal.
        fact.status = 'ran';
        fact.seeded = event.seeded ?? null;
        break;
      case 'drain-completed':
        fact.queueAfterDrain = event.queueAfterDrain ?? null;
        break;
      case 'drain-deferred':
        fact.status = 'deferred';
        fact.blockers = event.blockers ?? [];
        fact.waitedMs = event.waitedMs ?? null;
        break;
      case 'drain-waited':
        fact.waitedMs = event.waitedMs ?? null;
        break;
      case 'attempts-recorded':
        fact.attemptsRecordedFromLog =
          (fact.attemptsRecordedFromLog ?? 0) + (event.attemptsRecorded ?? 0);
        break;
      case 'bill-resolved':
        fact.resolvedBills += 1;
        break;
      case 'drain-skipped':
        fact.status = 'archive-sync-deferred';
        fact.blockers = event.blockers ?? [];
        break;
      case 'summary-backfill-pass':
        fact.summaryBackfillRan = true;
        break;
      default:
        break;
    }
  }

  return byTick;
}

/** UTC instant formatted the way TypeORM stores datetimes in SQLite. */
export function toSqliteUtc(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Pool predicate, evaluated as materialized sets instead of the correlated
 * `NOT EXISTS` subqueries the application query uses.
 *
 * The application form is O(matched archives x reason-detail rows): on the
 * production database (21,486 archives, 31,381 `proposalReason` details) the
 * correlated count measured **137.1 s**, while this set-based equivalent of the
 * same predicate returned the identical result in **2.8 s**. An observation tool
 * that costs over two minutes per snapshot is not usable per window, and the
 * difference is purely how the same predicate is evaluated.
 *
 * The conditions mirror `getProposalReasonRetryCandidates`
 * (`modules/notice/utils/notice-archive-maintenance-support.ts`) exactly:
 * active lifecycle, at or above the current Assembly's first notice number,
 * empty reason column, no recorded reason arrival, and no recorded
 * `source_deleted` transition.
 */
export const POOL_PREDICATE_SQL = `
  na.lifecycle_status = 'active'
  AND na.noticeNum >= ${POOL_MIN_NOTICE_NUM}
  AND (na.proposalReason IS NULL OR TRIM(na.proposalReason) = '')
  AND reason.noticeNum IS NULL
  AND gone.noticeNum IS NULL
`;

const POOL_JOINS_SQL = `
  LEFT JOIN (
    SELECT DISTINCT e.notice_num AS noticeNum
    FROM notice_change_events e
    INNER JOIN notice_change_details d ON d.event_id = e.id
    WHERE d.field_path = 'proposalReason'
      AND d.after_value IS NOT NULL
      AND TRIM(d.after_value) != ''
  ) reason ON reason.noticeNum = na.noticeNum
  LEFT JOIN (
    SELECT DISTINCT e.notice_num AS noticeNum
    FROM notice_change_events e
    INNER JOIN notice_change_details d ON d.event_id = e.id
    WHERE d.field_path = 'lifecycleStatus'
      AND d.after_value = 'source_deleted'
  ) gone ON gone.noticeNum = na.noticeNum
`;

function openReadOnly(databasePath: string): Database {
  // A read-only handle never blocks the running app's WAL writes, and keeps the
  // reporter incapable of changing what it measures.
  return new Database(databasePath, 2 /* sqlite3.OPEN_READONLY */);
}

function all<T>(
  db: Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows: T[]) =>
      error ? reject(error) : resolve(rows),
    );
  });
}

export async function collectDbFacts(
  databasePath: string,
  options: { from: Date; to: Date; includePoolScan: boolean },
): Promise<DbFacts> {
  const db = openReadOnly(databasePath);

  try {
    const columns = await all<{ name: string }>(
      db,
      `SELECT name FROM pragma_table_info('notice_archives')`,
    );
    const columnNames = new Set(columns.map((column) => column.name));
    const trackingColumnsPresent =
      columnNames.has('proposal_reason_retry_count') &&
      columnNames.has('proposal_reason_retried_at');

    const fromIso = toSqliteUtc(options.from);

    const reasonArrivals = await all<{
      createdAt: string;
      contentId: string | null;
    }>(
      db,
      `SELECT MAX(e.created_at) AS createdAt, e.notice_num AS noticeNum, na.contentId AS contentId
       FROM notice_change_events e
       INNER JOIN notice_change_details d ON d.event_id = e.id
       LEFT JOIN notice_archives na ON na.noticeNum = e.notice_num
       WHERE d.field_path = 'proposalReason'
         AND d.after_value IS NOT NULL
         AND TRIM(d.after_value) != ''
         AND e.created_at >= ?
       GROUP BY e.notice_num
       ORDER BY createdAt ASC`,
      [fromIso],
    );

    let poolSummary: PoolSummary | null = null;
    let poolQueryMs = 0;
    let coverage: { attempted: number; neverAttempted: number } | null = null;
    let stuckRows: StuckRow[] = [];
    let attemptStamps: DbFacts['attemptStamps'] = [];

    if (options.includePoolScan) {
      const startedAt = Date.now();
      const [summary] = await all<{
        total: number;
        contentIdNull: number | null;
        realTargets: number | null;
      }>(
        db,
        `SELECT COUNT(*) AS total,
                SUM(na.contentId IS NULL) AS contentIdNull,
                SUM(na.contentId IS NOT NULL) AS realTargets
         FROM notice_archives na
         ${POOL_JOINS_SQL}
         WHERE ${POOL_PREDICATE_SQL}`,
      );
      poolQueryMs = Date.now() - startedAt;

      poolSummary = {
        total: Number(summary?.total ?? 0),
        contentIdNull: Number(summary?.contentIdNull ?? 0),
        realTargets: Number(summary?.realTargets ?? 0),
      };

      if (trackingColumnsPresent) {
        const [counts] = await all<{
          attempted: number;
          neverAttempted: number;
        }>(
          db,
          `SELECT
             SUM(na.proposal_reason_retry_count > 0) AS attempted,
             SUM(na.proposal_reason_retry_count = 0) AS neverAttempted
           FROM notice_archives na
           ${POOL_JOINS_SQL}
           WHERE ${POOL_PREDICATE_SQL}`,
        );

        coverage = {
          attempted: Number(counts?.attempted ?? 0),
          neverAttempted: Number(counts?.neverAttempted ?? 0),
        };

        const stuck = await all<{
          noticeNum: number;
          retryCount: number;
          contentId: string | null;
        }>(
          db,
          `SELECT na.noticeNum AS noticeNum,
                  na.proposal_reason_retry_count AS retryCount,
                  na.contentId AS contentId
           FROM notice_archives na
           ${POOL_JOINS_SQL}
           WHERE ${POOL_PREDICATE_SQL}
             AND na.proposal_reason_retry_count >= 3
           ORDER BY na.proposal_reason_retry_count DESC
           LIMIT 20`,
        );

        stuckRows = stuck.map((row) => ({
          noticeNum: row.noticeNum,
          retryCount: row.retryCount,
          contentIdPresent: row.contentId != null,
        }));
      }
    }

    if (trackingColumnsPresent) {
      const stamps = await all<{
        noticeNum: number;
        retryCount: number;
        retriedAt: string | null;
        contentId: string | null;
      }>(
        db,
        `SELECT na.noticeNum AS noticeNum,
                na.proposal_reason_retry_count AS retryCount,
                na.proposal_reason_retried_at AS retriedAt,
                na.contentId AS contentId
         FROM notice_archives na
         WHERE na.proposal_reason_retried_at IS NOT NULL
           AND na.proposal_reason_retried_at >= ?`,
        [fromIso],
      );

      attemptStamps = stamps.map((row) => ({
        noticeNum: row.noticeNum,
        retryCount: row.retryCount,
        retriedAt: row.retriedAt ? new Date(`${row.retriedAt}Z`) : null,
        contentIdPresent: row.contentId != null,
      }));
    }

    return {
      poolQueryMs,
      poolSummary,
      trackingColumnsPresent,
      reasonArrivals: reasonArrivals
        .filter((row) => row.createdAt)
        .map((row) => ({
          at: new Date(`${row.createdAt}Z`),
          noticeNum: Number(
            (row as unknown as { noticeNum: number }).noticeNum,
          ),
          contentIdPresent: row.contentId != null,
        })),
      attemptStamps,
      coverage,
      stuckRows,
    };
  } finally {
    await new Promise<void>((resolve) => db.close(() => resolve()));
  }
}

/** Merges per-tick log facts with the database facts projected onto each tick. */
export function buildReport(params: {
  databasePath: string;
  logUtcOffsetMinutes: number;
  tickGrid: TickGrid;
  ticks: Date[];
  dbFacts: DbFacts | null;
  logEvents: DrainLogEvent[];
  unparsedLogLines: number;
  generatedAt: Date;
}): DrainObservationReport {
  const {
    databasePath,
    logUtcOffsetMinutes,
    tickGrid,
    ticks,
    dbFacts,
    logEvents,
    unparsedLogLines,
    generatedAt,
  } = params;

  const logFacts = summarizeTicks(logEvents, ticks);
  const stepMs = tickGrid.stepMinutes * 60_000;
  const windowFrom = ticks[0] ?? generatedAt;
  const windowTo = new Date(
    (ticks[ticks.length - 1]?.getTime() ?? generatedAt.getTime()) + stepMs,
  );

  const arrivals = dbFacts?.reasonArrivals ?? [];
  const attempts = dbFacts?.attemptStamps ?? [];

  const tickFacts: TickFacts[] = ticks.map((tickStart) => {
    const key = tickStart.toISOString();
    const base = logFacts.get(key);
    const tickEnd = new Date(tickStart.getTime() + stepMs);

    const arrivalsInWindow = arrivals.filter(
      (arrival) =>
        arrival.at >= tickStart && arrival.at.getTime() < tickEnd.getTime(),
    ).length;

    const poolEstimateAtEnd = dbFacts?.poolSummary
      ? dbFacts.poolSummary.total +
        arrivals.filter((arrival) => arrival.at >= tickEnd).length
      : null;

    const realTargetsEstimateAtEnd = dbFacts?.poolSummary
      ? dbFacts.poolSummary.realTargets +
        arrivals.filter(
          (arrival) => arrival.at >= tickEnd && arrival.contentIdPresent,
        ).length
      : null;

    return {
      tickStartIso: key,
      status: base?.status ?? 'no tick log',
      blockers: base?.blockers ?? [],
      waitedMs: base?.waitedMs ?? null,
      seeded: base?.seeded ?? null,
      attemptsRecordedFromLog: base?.attemptsRecordedFromLog ?? null,
      resolvedBills: base?.resolvedBills ?? 0,
      queueAfterDrain: base?.queueAfterDrain ?? null,
      summaryBackfillRan: base?.summaryBackfillRan ?? false,
      attemptsStampedInWindow: dbFacts?.trackingColumnsPresent
        ? attempts.filter(
            (stamp) =>
              stamp.retriedAt &&
              stamp.retriedAt >= tickStart &&
              stamp.retriedAt.getTime() < tickEnd.getTime(),
          ).length
        : null,
      recoverableAttemptsInWindow: dbFacts?.trackingColumnsPresent
        ? attempts.filter(
            (stamp) =>
              stamp.contentIdPresent &&
              stamp.retriedAt &&
              stamp.retriedAt >= tickStart &&
              stamp.retriedAt.getTime() < tickEnd.getTime(),
          ).length
        : null,
      arrivalsInWindow,
      poolEstimateAtEnd,
      realTargetsEstimateAtEnd,
    };
  });

  const report: DrainObservationReport = {
    databasePath,
    generatedAtIso: generatedAt.toISOString(),
    logUtcOffsetMinutes,
    tickGrid,
    window: {
      fromIso: windowFrom.toISOString(),
      toIso: windowTo.toISOString(),
    },
    poolQueryMs: dbFacts?.poolQueryMs ?? 0,
    poolSummary: dbFacts?.poolSummary ?? null,
    trackingColumnsPresent: dbFacts?.trackingColumnsPresent ?? false,
    coverage: dbFacts?.coverage ?? null,
    stuckRows: dbFacts?.stuckRows ?? [],
    realTargetArrivals: arrivals.filter((arrival) => arrival.contentIdPresent)
      .length,
    recoverableRowsAttempted: attempts.filter(
      (stamp) =>
        stamp.contentIdPresent &&
        stamp.retriedAt != null &&
        stamp.retriedAt >= windowFrom,
    ).length,
    distinctRowsAttempted: attempts.length,
    replayedTicks: tickFacts.length,
    unparsedLogLines,
    ticks: tickFacts,
    verdicts: [],
  };

  report.verdicts = evaluateVerdicts(report);
  return report;
}

/**
 * Pass/fail rules for one observation window. Each one answers a question the
 * backlog can hide behind: did the tick run at all, did the pool move, did the
 * cursor rotate, did the real targets shrink, and did it stay inside its budget.
 */
export function evaluateVerdicts(report: DrainObservationReport): Verdict[] {
  const verdicts: Verdict[] = [];
  const ticks = report.ticks;
  const observed = ticks.length;
  const ranTicks = ticks.filter((tick) => tick.status === 'ran').length;
  const deferredTicks = ticks.filter(
    (tick) => tick.status === 'deferred',
  ).length;
  const skippedTicks = ticks.filter(
    (tick) => tick.status === 'archive-sync-deferred',
  ).length;
  const poolTotal = report.poolSummary?.total ?? null;

  verdicts.push(
    report.trackingColumnsPresent
      ? {
          id: 'retry-tracking-deployed',
          label: 'attempt-history columns exist',
          level: 'pass',
          detail:
            'proposal_reason_retry_count / proposal_reason_retried_at are present, so the candidate cursor can advance by attempt history',
        }
      : {
          id: 'retry-tracking-deployed',
          label: 'attempt-history columns exist',
          level: 'fail',
          detail:
            'the retry-tracking migration is not deployed; every tick re-seeds the same noticeNum head and the pool cannot rotate',
        },
  );

  if (observed === 0) {
    verdicts.push({
      id: 'drain-tick-executed',
      label: 'drain tick executed',
      level: 'fail',
      detail: 'no tick windows were replayed; widen --ticks or check --logs',
    });
    return verdicts;
  }

  const ranRatio = ranTicks / observed;
  verdicts.push({
    id: 'drain-tick-executed',
    label: 'drain tick executed',
    level: ranRatio >= 0.75 ? 'pass' : ranRatio > 0 ? 'warn' : 'fail',
    detail: `ran on ${ranTicks}/${observed} ticks (deferred ${deferredTicks} = browser held, archive-sync skip ${skippedTicks}); a starved guard shows 0`,
  });

  const loggedAttempts = ticks.reduce(
    (total, tick) => total + (tick.attemptsRecordedFromLog ?? 0),
    0,
  );
  const arrivalsTotal = ticks.reduce(
    (total, tick) => total + tick.arrivalsInWindow,
    0,
  );

  verdicts.push(
    poolTotal === 0
      ? {
          id: 'pool-moved',
          label: 'pool moved',
          level: 'skip',
          detail: 'the pool is empty; there is nothing left to drain',
        }
      : loggedAttempts + arrivalsTotal > 0
        ? {
            id: 'pool-moved',
            label: 'pool moved',
            level: 'pass',
            detail: `${loggedAttempts} attempt(s) stamped and ${arrivalsTotal} reason arrival(s) in the window, against a pool of ${poolTotal}`,
          }
        : {
            id: 'pool-moved',
            label: 'pool moved',
            level: 'fail',
            detail: `0 attempts and 0 arrivals across ${observed} ticks with ${
              poolTotal == null
                ? 'the pool not sampled'
                : `${poolTotal} row(s) waiting`
            }`,
          },
  );

  if (!report.trackingColumnsPresent || poolTotal == null) {
    verdicts.push({
      id: 'cursor-rotated',
      label: 'cursor rotated instead of pinning',
      level: 'skip',
      detail: 'needs the attempt-history columns and a pool snapshot',
    });
  } else if (poolTotal === 0) {
    verdicts.push({
      id: 'cursor-rotated',
      label: 'cursor rotated instead of pinning',
      level: 'skip',
      detail: 'the pool is empty',
    });
  } else if (loggedAttempts === 0) {
    verdicts.push({
      id: 'cursor-rotated',
      label: 'cursor rotated instead of pinning',
      level: 'skip',
      detail:
        'no tick reported stamped attempts, so there is nothing to compare',
    });
  } else {
    // Best case: every attempt lands on a row the drain had not reached yet, so
    // distinct rows equal attempts (capped by the pool). A pinned cursor spends
    // many attempts per distinct row while the pool itself never shrinks.
    const expectedDistinct = Math.min(poolTotal, loggedAttempts);
    const share =
      expectedDistinct > 0
        ? report.distinctRowsAttempted / expectedDistinct
        : 0;

    verdicts.push({
      id: 'cursor-rotated',
      label: 'cursor rotated instead of pinning',
      level: share >= 0.8 ? 'pass' : share >= 0.5 ? 'warn' : 'fail',
      detail: `${loggedAttempts} logged attempt(s) reached ${report.distinctRowsAttempted} distinct row(s); ${expectedDistinct} were reachable on a rotating cursor (share ${share.toFixed(2)}, pool ${poolTotal})`,
    });
  }

  const realTargetsNow = report.poolSummary?.realTargets ?? null;
  if (realTargetsNow == null) {
    verdicts.push({
      id: 'real-targets-burned-down',
      label: 'recoverable rows burned down',
      level: 'skip',
      detail: 'needs a pool snapshot (--no-pool-scan was used)',
    });
  } else if (realTargetsNow + report.realTargetArrivals === 0) {
    verdicts.push({
      id: 'real-targets-burned-down',
      label: 'recoverable rows burned down',
      level: 'skip',
      detail: 'no row in the pool has a recoverable source (contentId)',
    });
  } else {
    const baseline = realTargetsNow + report.realTargetArrivals;
    const left = baseline - realTargetsNow;
    const attempted = report.recoverableRowsAttempted;

    // Reaching a recoverable row and failing to resolve it is not the same
    // failure as never reaching it: the first one may just mean the source does
    // not publish the reason yet, while the second is the cursor pinning that
    // this whole observation exists to catch.
    verdicts.push({
      id: 'real-targets-burned-down',
      label: 'recoverable rows burned down',
      level: left > 0 ? 'pass' : attempted > 0 ? 'warn' : 'fail',
      detail:
        left > 0
          ? `${left} of ${baseline} recoverable row(s) left the pool; ${realTargetsNow} remaining`
          : attempted > 0
            ? `${attempted} recoverable row(s) were attempted but none returned a reason; ${realTargetsNow} remaining (the source may not publish them yet)`
            : `none of the ${realTargetsNow} recoverable row(s) was attempted in this window`,
    });
  }

  const overflow = ticks.filter(
    (tick) =>
      (tick.attemptsRecordedFromLog ?? 0) > SEED_LIMIT ||
      (tick.waitedMs ?? 0) > 900_000,
  );
  verdicts.push({
    id: 'tick-cost-in-budget',
    label: 'tick stayed inside its budget',
    level: overflow.length === 0 ? 'pass' : 'warn',
    detail:
      overflow.length === 0
        ? `no tick exceeded ${SEED_LIMIT} seeded row(s) or the 15-minute window`
        : `${overflow.length} tick(s) exceeded the seed limit or the window: ${overflow
            .map((tick) => tick.tickStartIso)
            .join(', ')}`,
  });

  const seededTicks = ticks.filter((tick) => (tick.seeded ?? 0) > 0);
  const seededWithoutStamp = seededTicks.filter(
    (tick) => (tick.attemptsRecordedFromLog ?? 0) === 0,
  );
  verdicts.push(
    seededTicks.length === 0
      ? {
          id: 'attempt-stamp-alive',
          label: 'attempt stamps written',
          level: 'skip',
          detail: 'no tick seeded rows in this window',
        }
      : {
          id: 'attempt-stamp-alive',
          label: 'attempt stamps written',
          level: seededWithoutStamp.length === 0 ? 'pass' : 'fail',
          detail:
            seededWithoutStamp.length === 0
              ? `all ${seededTicks.length} tick(s) that seeded rows also stamped them, so the next page moves`
              : `${seededWithoutStamp.length} of ${seededTicks.length} seeding tick(s) stamped no attempt; the cursor will re-seed the same head`,
        },
  );

  return verdicts;
}

function formatTickLine(tick: TickFacts): string {
  const cell = (value: string | number | null, width: number) =>
    String(value ?? '-').padEnd(width);

  return [
    cell(tick.tickStartIso.replace('T', ' ').slice(0, 16), 17),
    cell(tick.status, 24),
    cell(tick.seeded, 5),
    cell(tick.attemptsRecordedFromLog, 9),
    cell(tick.attemptsStampedInWindow, 8),
    cell(tick.recoverableAttemptsInWindow, 7),
    cell(tick.arrivalsInWindow, 7),
    cell(tick.resolvedBills, 9),
    cell(tick.queueAfterDrain, 6),
    cell(tick.waitedMs, 7),
    cell(tick.poolEstimateAtEnd, 7),
    cell(tick.realTargetsEstimateAtEnd, 6),
    tick.summaryBackfillRan ? 'yes' : 'no',
  ].join(' ');
}

export function renderReport(report: DrainObservationReport): string {
  const lines: string[] = [];
  const pool = report.poolSummary;

  lines.push('proposalReason drain observation');
  lines.push(`  database            ${report.databasePath}`);
  lines.push(`  generated (UTC)     ${report.generatedAtIso}`);
  lines.push(
    `  window (UTC)        ${report.window.fromIso} .. ${report.window.toIso}`,
  );
  lines.push(
    `  tick grid           every ${report.tickGrid.stepMinutes} min from :${String(
      report.tickGrid.anchorMinute,
    ).padStart(2, '0')} (${TICK_CRON_EXPRESSION})`,
  );
  lines.push(
    `  log time offset     ${report.logUtcOffsetMinutes} min subtracted from log timestamps`,
  );
  lines.push(
    `  attempt history     ${
      report.trackingColumnsPresent
        ? 'tracked'
        : 'MISSING (migration not deployed)'
    }`,
  );
  lines.push(
    `  pool scope          noticeNum >= ${POOL_MIN_NOTICE_NUM} (Assembly ${APP_CONSTANTS.ARCHIVE_SYNC.CURRENT_ASSEMBLY} and later)`,
  );
  lines.push(
    `  pool snapshot       ${
      pool
        ? `${pool.total} row(s) = ${pool.contentIdNull} without a recoverable source + ${pool.realTargets} recoverable (query ${report.poolQueryMs} ms)`
        : 'skipped (--no-pool-scan)'
    }`,
  );
  if (report.coverage) {
    lines.push(
      `  attempt coverage    ${report.coverage.attempted} row(s) attempted at least once, ${report.coverage.neverAttempted} never attempted`,
    );
  }
  lines.push(
    `  reason arrivals     ${report.realTargetArrivals} recoverable row(s) left the pool during the window`,
  );
  lines.push(
    `  reached recoverable ${report.recoverableRowsAttempted} row(s) with a recoverable source were attempted in the window`,
  );
  if (report.stuckRows.length > 0) {
    lines.push(
      `  stuck rows          ${report.stuckRows
        .slice(0, 10)
        .map((row) => `${row.noticeNum}x${row.retryCount}`)
        .join(', ')}`,
    );
  }
  if (report.unparsedLogLines > 0) {
    lines.push(
      `  unparsed log lines  ${report.unparsedLogLines} (check --log-utc-offset and the log format)`,
    );
  }

  lines.push('');
  lines.push(
    '  tick (UTC)        status                   seed  att(log)  att(db)  realAtt  arriv  resolved  queue  wait   pool~   real~  summary',
  );
  for (const tick of report.ticks) {
    lines.push(`  ${formatTickLine(tick)}`);
  }

  lines.push('');
  lines.push('  verdicts');
  for (const verdict of report.verdicts) {
    lines.push(`  [${verdict.level.toUpperCase().padEnd(4)}] ${verdict.label}`);
    lines.push(`         ${verdict.detail}`);
  }

  const failed = report.verdicts.filter((verdict) => verdict.level === 'fail');
  lines.push('');
  lines.push(
    failed.length === 0
      ? '  result: no failing check - the window shows the backlog draining'
      : `  result: ${failed.length} failing check(s): ${failed
          .map((verdict) => verdict.id)
          .join(', ')}`,
  );

  return lines.join('\n');
}

interface CliOptions {
  databasePath: string;
  logsPath: string | null;
  ticks: number;
  logUtcOffsetMinutes: number;
  json: boolean;
  includePoolScan: boolean;
}

export function parseCliOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const options: CliOptions = {
    databasePath: env.DATABASE_PATH ?? './lawcast.db',
    logsPath: null,
    ticks: 16,
    logUtcOffsetMinutes: 540,
    json: false,
    includePoolScan: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    switch (flag) {
      case '--db':
        options.databasePath = value ?? options.databasePath;
        index += 1;
        break;
      case '--logs':
        options.logsPath = value ?? null;
        index += 1;
        break;
      case '--ticks':
        options.ticks = Math.max(1, Number(value) || options.ticks);
        index += 1;
        break;
      case '--log-utc-offset':
        options.logUtcOffsetMinutes = Number(value);
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--no-pool-scan':
        options.includePoolScan = false;
        break;
      default:
        break;
    }
  }

  return options;
}

function readLogLines(options: CliOptions): string[] {
  if (!options.logsPath) {
    return [];
  }

  if (options.logsPath === '-') {
    if (process.stdin.isTTY) {
      // Without this the read fails with a bare EAGAIN, which reads like a bug
      // in the reporter rather than a missing pipe.
      throw new Error(
        '--logs - expects the log on stdin (for example `docker logs lawcast-backend | ... --logs -`)',
      );
    }

    return readFileSync(0, 'utf8').split('\n');
  }

  return readFileSync(options.logsPath, 'utf8').split('\n');
}

export async function runObservation(
  options: CliOptions,
  now: Date = new Date(),
): Promise<DrainObservationReport> {
  const grid = parseTickGrid(TICK_CRON_EXPRESSION);
  const stepMs = grid.stepMinutes * 60_000;
  const currentTick = tickStartFor(now, grid);
  const ticks = Array.from(
    { length: options.ticks },
    (_, index) =>
      new Date(currentTick.getTime() - (options.ticks - 1 - index) * stepMs),
  );

  const from = ticks[0] ?? currentTick;
  const { events, unparsedLines } = parseDrainLogEvents(
    readLogLines(options),
    grid,
    options.logUtcOffsetMinutes,
  );

  const dbFacts = await collectDbFacts(options.databasePath, {
    from,
    to: now,
    includePoolScan: options.includePoolScan,
  });

  return buildReport({
    databasePath: options.databasePath,
    logUtcOffsetMinutes: options.logUtcOffsetMinutes,
    tickGrid: grid,
    ticks,
    dbFacts,
    logEvents: events,
    unparsedLogLines: unparsedLines,
    generatedAt: now,
  });
}

async function main(): Promise<number> {
  const options = parseCliOptions(process.argv.slice(2));
  const report = await runObservation(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
  }

  return report.verdicts.some((verdict) => verdict.level === 'fail') ? 1 : 0;
}

if (require.main === module) {
  void main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `proposalReason drain observation failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 2;
    });
}
