import { Database } from 'sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReport,
  collectDbFacts,
  evaluateVerdicts,
  parseCliOptions,
  parseDrainLogEvents,
  parseNestLogTimestamp,
  parseTickGrid,
  tickStartFor,
  type DrainObservationReport,
  type TickFacts,
} from './proposal-reason-drain-observation';

const KST_OFFSET_MINUTES = 540;
const GRID = { anchorMinute: 9, stepMinutes: 15 };

const nestLine = (localTimestamp: string, message: string): string =>
  `[Nest] 7  - ${localTimestamp}     LOG [CrawlingSchedulerService] ${message}`;

const emptyTick = (
  tickStartIso: string,
  overrides: Partial<TickFacts> = {},
): TickFacts => ({
  tickStartIso,
  status: 'no tick log',
  blockers: [],
  waitedMs: null,
  seeded: null,
  attemptsRecordedFromLog: null,
  resolvedBills: 0,
  queueAfterDrain: null,
  summaryBackfillRan: false,
  attemptsStampedInWindow: null,
  recoverableAttemptsInWindow: null,
  arrivalsInWindow: 0,
  poolEstimateAtEnd: null,
  realTargetsEstimateAtEnd: null,
  ...overrides,
});

const buildReportFixture = (
  ticks: TickFacts[],
  overrides: Partial<DrainObservationReport> = {},
): DrainObservationReport => ({
  databasePath: ':memory:',
  generatedAtIso: '2026-10-14T13:09:00.000Z',
  logUtcOffsetMinutes: KST_OFFSET_MINUTES,
  tickGrid: GRID,
  window: {
    fromIso: '2026-10-14T12:09:00.000Z',
    toIso: '2026-10-14T13:09:00.000Z',
  },
  poolQueryMs: 2836,
  poolSummary: { total: 334, contentIdNull: 314, realTargets: 20 },
  trackingColumnsPresent: true,
  coverage: { attempted: 180, neverAttempted: 154 },
  stuckRows: [],
  realTargetArrivals: 0,
  recoverableRowsAttempted: 0,
  distinctRowsAttempted: 0,
  replayedTicks: ticks.length,
  unparsedLogLines: 0,
  ticks,
  verdicts: [],
  ...overrides,
});

const verdictLevel = (
  report: DrainObservationReport,
  id: string,
): string | undefined =>
  evaluateVerdicts(report).find((verdict) => verdict.id === id)?.level;

describe('proposalReason drain observation', () => {
  describe('tick grid', () => {
    it('reads the anchor and step out of the drain cron expression', () => {
      expect(parseTickGrid('9-59/15 * * * *')).toEqual({
        anchorMinute: 9,
        stepMinutes: 15,
      });
      expect(parseTickGrid('*/15 * * * *')).toEqual({
        anchorMinute: 0,
        stepMinutes: 15,
      });
      // An expression shape this parser does not model must not silently shift
      // every bucket: it falls back to the documented drain grid.
      expect(parseTickGrid('7 4 * * *')).toEqual({
        anchorMinute: 9,
        stepMinutes: 15,
      });
    });

    it('buckets instants into the tick that owns them, including across the hour', () => {
      const at = (iso: string) =>
        tickStartFor(new Date(iso), GRID).toISOString();

      expect(at('2026-10-14T12:09:00Z')).toBe('2026-10-14T12:09:00.000Z');
      expect(at('2026-10-14T12:23:59Z')).toBe('2026-10-14T12:09:00.000Z');
      expect(at('2026-10-14T12:24:00Z')).toBe('2026-10-14T12:24:00.000Z');
      expect(at('2026-10-14T12:53:00Z')).toBe('2026-10-14T12:39:00.000Z');
      expect(at('2026-10-14T12:54:00Z')).toBe('2026-10-14T12:54:00.000Z');
      // The :54 tick owns everything up to the next tick at :09.
      expect(at('2026-10-14T12:08:00Z')).toBe('2026-10-14T11:54:00.000Z');
      expect(at('2026-10-14T00:05:00Z')).toBe('2026-10-13T23:54:00.000Z');
    });
  });

  describe('log parsing', () => {
    it('converts the container-local timestamp to UTC', () => {
      // The backend container runs with TZ=Asia/Seoul while SQLite stores UTC.
      expect(
        parseNestLogTimestamp(
          nestLine('10/15/2026, 12:39:23 AM', 'x'),
          KST_OFFSET_MINUTES,
        )?.at.toISOString(),
      ).toBe('2026-10-14T15:39:23.000Z');

      expect(
        parseNestLogTimestamp(
          nestLine('10/15/2026, 12:39:23 PM', 'x'),
          KST_OFFSET_MINUTES,
        )?.at.toISOString(),
      ).toBe('2026-10-15T03:39:23.000Z');

      expect(
        parseNestLogTimestamp('not a nest line', KST_OFFSET_MINUTES),
      ).toBeNull();
    });

    it('classifies each tick of the drain and counts what it did', () => {
      const log = [
        // A tick that ran: seeding, stamped attempts, one resolved bill.
        nestLine(
          '10/14/2026, 9:39:12 PM',
          'proposalReason retry cron: queue before=0, seeded=20, queue after seed=20',
        ),
        nestLine(
          '10/14/2026, 9:39:20 PM',
          'proposalReason retry: recorded 20 attempt(s) for candidate rotation',
        ),
        nestLine(
          '10/14/2026, 9:41:02 PM',
          'proposalReason retry: resolved bill 2219108 after 2 attempt(s)',
        ),
        nestLine(
          '10/14/2026, 9:49:30 PM',
          'proposalReason retry cron: drain completed, queue after drain=19',
        ),
        // A tick whose browser window never opened.
        nestLine(
          '10/14/2026, 9:54:05 PM',
          'proposalReason retry cron: deferred this tick - browser lease held the browser for 300012ms',
        ),
        // A tick the cron took away on archive-sync work.
        nestLine(
          '10/14/2026, 10:09:03 PM',
          'proposalReason NSM reason drain skipped - archive sync write-heavy phase is currently running (runningWriteHeavyPhases=isDone sync)',
        ),
        nestLine(
          '10/14/2026, 10:09:40 PM',
          'Summary backfill staged - scanned=340 stagedPending=315 retryScanned=0 stagedRetry=0 queue=0',
        ),
        '2026-10-14 21:24:00 something without a log header',
      ];

      const { events, unparsedLines } = parseDrainLogEvents(
        log,
        GRID,
        KST_OFFSET_MINUTES,
      );

      // 21:39:12 KST = 12:39:12Z, 21:54:05 KST = 12:54:05Z, 22:09:03 KST = 13:09:03Z.
      const byTick = new Map(
        events.map((event) => [
          `${event.tickStart.toISOString()} ${event.kind}`,
          event,
        ]),
      );

      expect(byTick.get('2026-10-14T12:39:00.000Z tick-seeded')?.seeded).toBe(
        20,
      );
      expect(
        byTick.get('2026-10-14T12:39:00.000Z drain-completed')?.queueAfterDrain,
      ).toBe(19);
      expect(
        byTick.get('2026-10-14T12:39:00.000Z attempts-recorded')
          ?.attemptsRecorded,
      ).toBe(20);
      expect(byTick.get('2026-10-14T12:39:00.000Z bill-resolved')?.billNo).toBe(
        '2219108',
      );
      expect(
        byTick.get('2026-10-14T12:54:00.000Z drain-deferred')?.blockers,
      ).toEqual(['browser lease']);
      expect(
        byTick.get('2026-10-14T13:09:00.000Z drain-skipped')?.blockers,
      ).toEqual([
        'archive sync write-heavy phase is currently running (runningWriteHeavyPhases=isDone sync)',
      ]);
      expect(unparsedLines).toBe(1);
    });

    it('summarizes a tick from its own events only', () => {
      const log = [
        nestLine(
          '10/14/2026, 9:39:12 PM',
          'proposalReason retry cron: queue before=0, seeded=20, queue after seed=20',
        ),
        nestLine(
          '10/14/2026, 9:39:20 PM',
          'proposalReason retry: recorded 20 attempt(s) for candidate rotation',
        ),
        nestLine(
          '10/14/2026, 9:39:20 PM',
          'proposalReason retry: recorded 3 attempt(s) for candidate rotation',
        ),
        nestLine(
          '10/14/2026, 9:40:00 PM',
          'proposalReason retry: resolved bill 1 after 1 attempt(s)',
        ),
        nestLine(
          '10/14/2026, 9:40:01 PM',
          'proposalReason retry: resolved bill 2 after 1 attempt(s)',
        ),
        // The other half of the tick, reported so a passing drain is read next
        // to a live summary backfill.
        nestLine(
          '10/14/2026, 9:39:37 PM',
          'Summary backfill staged - scanned=340 stagedPending=315 retryScanned=0 stagedRetry=0 queue=0',
        ),
      ];

      const { events } = parseDrainLogEvents(log, GRID, KST_OFFSET_MINUTES);
      const tickStart = new Date('2026-10-14T12:39:00.000Z');
      const facts = buildReport({
        databasePath: ':memory:',
        logUtcOffsetMinutes: KST_OFFSET_MINUTES,
        tickGrid: GRID,
        ticks: [tickStart],
        dbFacts: null,
        logEvents: events,
        unparsedLogLines: 0,
        generatedAt: new Date('2026-10-14T13:00:00.000Z'),
      }).ticks[0];

      expect(facts.status).toBe('ran');
      expect(facts.seeded).toBe(20);
      expect(facts.attemptsRecordedFromLog).toBe(23);
      expect(facts.resolvedBills).toBe(2);
      expect(facts.summaryBackfillRan).toBe(true);
    });
  });

  describe('verdicts', () => {
    const ranTick = (tickStartIso: string): TickFacts =>
      emptyTick(tickStartIso, {
        status: 'ran',
        seeded: 20,
        attemptsRecordedFromLog: 20,
      });

    it('fails a window in which the drain never ran', () => {
      const report = buildReportFixture([
        emptyTick('2026-10-14T12:09:00.000Z'),
        emptyTick('2026-10-14T12:24:00.000Z'),
      ]);

      expect(verdictLevel(report, 'drain-tick-executed')).toBe('fail');
      expect(verdictLevel(report, 'pool-moved')).toBe('fail');
    });

    it('fails a window that re-tried the same rows instead of rotating', () => {
      const report = buildReportFixture(
        [
          ranTick('2026-10-14T12:09:00.000Z'),
          ranTick('2026-10-14T12:24:00.000Z'),
          ranTick('2026-10-14T12:39:00.000Z'),
          ranTick('2026-10-14T12:54:00.000Z'),
        ],
        // 80 attempts landed on the same 20 rows: the cursor never advanced.
        { distinctRowsAttempted: 20 },
      );

      expect(verdictLevel(report, 'drain-tick-executed')).toBe('pass');
      expect(verdictLevel(report, 'cursor-rotated')).toBe('fail');
      expect(verdictLevel(report, 'attempt-stamp-alive')).toBe('pass');
    });

    it('passes a window that spends each attempt on a row it had not reached', () => {
      const report = buildReportFixture(
        [
          ranTick('2026-10-14T12:09:00.000Z'),
          ranTick('2026-10-14T12:24:00.000Z'),
          ranTick('2026-10-14T12:39:00.000Z'),
          ranTick('2026-10-14T12:54:00.000Z'),
        ],
        {
          distinctRowsAttempted: 80,
          realTargetArrivals: 20,
          recoverableRowsAttempted: 20,
        },
      );

      expect(verdictLevel(report, 'drain-tick-executed')).toBe('pass');
      expect(verdictLevel(report, 'pool-moved')).toBe('pass');
      expect(verdictLevel(report, 'cursor-rotated')).toBe('pass');
      expect(verdictLevel(report, 'real-targets-burned-down')).toBe('pass');
      expect(verdictLevel(report, 'tick-cost-in-budget')).toBe('pass');
      expect(verdictLevel(report, 'attempt-stamp-alive')).toBe('pass');
    });

    it('warns when recoverable rows were attempted but none resolved', () => {
      const report = buildReportFixture(
        [
          emptyTick('2026-10-14T12:09:00.000Z', {
            status: 'ran',
            seeded: 20,
            attemptsRecordedFromLog: 20,
          }),
        ],
        { recoverableRowsAttempted: 5, distinctRowsAttempted: 20 },
      );

      // Reaching them and finding nothing upstream is not the same defect as
      // never reaching them, so it must not be reported as the pinned cursor.
      expect(verdictLevel(report, 'real-targets-burned-down')).toBe('warn');
    });

    it('fails when recoverable rows were never reached', () => {
      const report = buildReportFixture(
        [
          emptyTick('2026-10-14T12:09:00.000Z', {
            status: 'ran',
            seeded: 20,
            attemptsRecordedFromLog: 20,
          }),
        ],
        { recoverableRowsAttempted: 0, distinctRowsAttempted: 20 },
      );

      expect(verdictLevel(report, 'real-targets-burned-down')).toBe('fail');
    });

    it('fails a tick that seeded rows without stamping attempts', () => {
      const report = buildReportFixture([
        emptyTick('2026-10-14T12:09:00.000Z', {
          status: 'ran',
          seeded: 20,
          attemptsRecordedFromLog: 0,
        }),
      ]);

      expect(verdictLevel(report, 'attempt-stamp-alive')).toBe('fail');
    });

    it('fails when the attempt-history migration is not deployed', () => {
      const report = buildReportFixture([ranTick('2026-10-14T12:09:00.000Z')], {
        trackingColumnsPresent: false,
        coverage: null,
      });

      expect(verdictLevel(report, 'retry-tracking-deployed')).toBe('fail');
      expect(verdictLevel(report, 'cursor-rotated')).toBe('skip');
    });

    it('warns when a tick exceeded its seed budget', () => {
      const report = buildReportFixture([
        emptyTick('2026-10-14T12:09:00.000Z', {
          status: 'ran',
          seeded: 40,
          attemptsRecordedFromLog: 40,
        }),
      ]);

      expect(verdictLevel(report, 'tick-cost-in-budget')).toBe('warn');
    });
  });

  describe('database facts against a real SQLite file', () => {
    let directory: string;
    let databasePath: string;

    const from = new Date('2026-10-14T12:09:00.000Z');

    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), 'drain-observation-'));
      databasePath = join(directory, 'lawcast.db');

      const db = new Database(databasePath);
      await new Promise<void>((resolve, reject) =>
        db.exec(
          `
          CREATE TABLE notice_archives (
            noticeNum INTEGER PRIMARY KEY,
            lifecycle_status TEXT NOT NULL DEFAULT 'active',
            proposalReason TEXT,
            contentId TEXT,
            proposal_reason_retry_count INTEGER NOT NULL DEFAULT 0,
            proposal_reason_retried_at DATETIME
          );
          CREATE TABLE notice_change_events (
            id INTEGER PRIMARY KEY,
            notice_num INTEGER NOT NULL,
            created_at DATETIME
          );
          CREATE TABLE notice_change_details (
            id INTEGER PRIMARY KEY,
            event_id INTEGER NOT NULL,
            field_path TEXT NOT NULL,
            after_value TEXT
          );

          -- 21076: a bill from an earlier Assembly. It is active and has no
          -- reason, but it sits below the backfill floor, so the pool must not
          -- count it (the drain never seeds it).
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId)
            VALUES (21076, 'active', NULL, NULL);
          -- 2201001: recoverable and never attempted.
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId)
            VALUES (2201001, 'active', NULL, 'c1');
          -- 2201002: no recoverable source, attempted once.
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId, proposal_reason_retry_count, proposal_reason_retried_at)
            VALUES (2201002, 'active', '  ', NULL, 1, '2026-10-14 12:20:00');
          -- 2201003: no recoverable source, attempted four times (stuck).
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId, proposal_reason_retry_count, proposal_reason_retried_at)
            VALUES (2201003, 'active', NULL, NULL, 4, '2026-10-14 12:40:00');
          -- 2201004: reason arrived through the chain, so it left the pool.
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId)
            VALUES (2201004, 'active', NULL, 'c2');
          INSERT INTO notice_change_events (id, notice_num, created_at) VALUES (1, 2201004, '2026-10-14 12:45:00');
          INSERT INTO notice_change_details (id, event_id, field_path, after_value) VALUES (1, 1, 'proposalReason', '사유');
          -- 2201005: the reason is already in the column.
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId)
            VALUES (2201005, 'active', 'already there', 'c3');
          -- 2201006: deleted at the source.
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId)
            VALUES (2201006, 'source_deleted', NULL, 'c4');
          -- 2201007: a source_deleted transition was recorded for it.
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId)
            VALUES (2201007, 'active', NULL, 'c5');
          INSERT INTO notice_change_events (id, notice_num, created_at) VALUES (2, 2201007, '2026-10-01 00:00:00');
          INSERT INTO notice_change_details (id, event_id, field_path, after_value) VALUES (2, 2, 'lifecycleStatus', 'source_deleted');
          `,
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      await new Promise<void>((resolve) => db.close(() => resolve()));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it('counts the pool exactly the way the candidate query does', async () => {
      const facts = await collectDbFacts(databasePath, {
        from,
        to: new Date('2026-10-14T13:09:00.000Z'),
        includePoolScan: true,
      });

      // 2201004 (recorded arrival), 2201005 (reason present), 2201006
      // (deleted) and 2201007 (recorded deletion) are all outside the
      // candidate set, and so is 21076: it is below the backfill floor, which
      // is why the pool counts three rows with a fourth reasonless row in the
      // table.
      expect(facts.poolSummary).toEqual({
        total: 3,
        contentIdNull: 2,
        realTargets: 1,
      });
      expect(facts.trackingColumnsPresent).toBe(true);
      expect(facts.coverage).toEqual({ attempted: 2, neverAttempted: 1 });
      expect(facts.stuckRows).toEqual([
        { noticeNum: 2201003, retryCount: 4, contentIdPresent: false },
      ]);
      expect(
        facts.attemptStamps.map((stamp) => stamp.noticeNum).sort(),
      ).toEqual([2201002, 2201003]);
      expect(
        facts.attemptStamps.filter((stamp) => stamp.contentIdPresent),
      ).toEqual([]);
    });

    it('projects the pool and arrivals onto each tick window', async () => {
      const dbFacts = await collectDbFacts(databasePath, {
        from,
        to: new Date('2026-10-14T13:09:00.000Z'),
        includePoolScan: true,
      });

      const ticks = [
        new Date('2026-10-14T12:09:00.000Z'),
        new Date('2026-10-14T12:24:00.000Z'),
        new Date('2026-10-14T12:39:00.000Z'),
        new Date('2026-10-14T12:54:00.000Z'),
      ];

      const report = buildReport({
        databasePath,
        logUtcOffsetMinutes: KST_OFFSET_MINUTES,
        tickGrid: GRID,
        ticks,
        dbFacts,
        logEvents: [],
        unparsedLogLines: 0,
        generatedAt: new Date('2026-10-14T13:09:00.000Z'),
      });

      expect(report.ticks.map((tick) => tick.attemptsStampedInWindow)).toEqual([
        1, 0, 1, 0,
      ]);
      expect(report.ticks.map((tick) => tick.arrivalsInWindow)).toEqual([
        0, 0, 1, 0,
      ]);
      // The pool at the end of the first tick still held the row that only
      // arrived later, so the burn-down estimate is reconstructible backwards.
      expect(report.ticks[0].poolEstimateAtEnd).toBe(4);
      expect(report.ticks[0].realTargetsEstimateAtEnd).toBe(2);
      expect(report.distinctRowsAttempted).toBe(2);
      expect(report.realTargetArrivals).toBe(1);
      // Neither stamped row has a recoverable source, so nothing was recovered.
      expect(report.recoverableRowsAttempted).toBe(0);
    });

    it('reads a database without the retry-tracking columns as untracked', async () => {
      const legacyPath = join(directory, 'legacy.db');
      const db = new Database(legacyPath);
      await new Promise<void>((resolve, reject) =>
        db.exec(
          `
          CREATE TABLE notice_archives (
            noticeNum INTEGER PRIMARY KEY,
            lifecycle_status TEXT NOT NULL DEFAULT 'active',
            proposalReason TEXT,
            contentId TEXT
          );
          CREATE TABLE notice_change_events (id INTEGER PRIMARY KEY, notice_num INTEGER NOT NULL, created_at DATETIME);
          CREATE TABLE notice_change_details (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, field_path TEXT NOT NULL, after_value TEXT);
          INSERT INTO notice_archives (noticeNum, lifecycle_status, proposalReason, contentId) VALUES (2200001, 'active', NULL, NULL);
          `,
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      await new Promise<void>((resolve) => db.close(() => resolve()));

      const facts = await collectDbFacts(legacyPath, {
        from,
        to: new Date('2026-10-14T13:09:00.000Z'),
        includePoolScan: true,
      });

      expect(facts.trackingColumnsPresent).toBe(false);
      expect(facts.coverage).toBeNull();
      expect(facts.stuckRows).toEqual([]);
      expect(facts.attemptStamps).toEqual([]);
      // The pool itself is still countable, so a pre-migration run still shows
      // how much is waiting.
      expect(facts.poolSummary?.total).toBe(1);
    });
  });

  describe('cli options', () => {
    it('defaults the database to the deployment path and the offset to KST', () => {
      const options = parseCliOptions([], {
        DATABASE_PATH: '/app/data/lawcast.db',
      });

      expect(options.databasePath).toBe('/app/data/lawcast.db');
      expect(options.ticks).toBe(16);
      expect(options.logUtcOffsetMinutes).toBe(540);
      expect(options.includePoolScan).toBe(true);
    });

    it('accepts the window, log source and JSON flags', () => {
      const options = parseCliOptions([
        '--db',
        '/tmp/x.db',
        '--logs',
        '-',
        '--ticks',
        '4',
        '--log-utc-offset',
        '0',
        '--json',
        '--no-pool-scan',
      ]);

      expect(options).toEqual({
        databasePath: '/tmp/x.db',
        logsPath: '-',
        ticks: 4,
        logUtcOffsetMinutes: 0,
        json: true,
        includePoolScan: false,
      });
    });
  });
});
