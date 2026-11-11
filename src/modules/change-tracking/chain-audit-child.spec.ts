import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DataSource } from 'typeorm';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { NoticeChangeEvent } from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';
import { NoticeChangeSource } from './notice-change-source.enum';
import { getTrackedFieldsForCanonVersion } from './change-tracking-diff.utils';
import { buildDiffEvent } from './change-tracking-event-builder';
import { runScheduledChainAuditInternal } from './change-tracking-chain-audit.utils';
import { superviseChainAuditChild } from './chain-audit-child-supervisor';
import { readChainAuditLimits } from './chain-audit-limits';

jest.setTimeout(30_000);

describe('Chain audit child integration', () => {
  let directory: string;
  let source: DataSource;
  let database: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'lawcast-audit-'));
    database = path.join(directory, 'fixture.sqlite');
    source = await new DataSource({
      type: 'better-sqlite3',
      database,
      synchronize: true,
      enableWAL: true,
      entities: [NoticeArchive, NoticeChangeEvent, NoticeChangeDetail],
    }).initialize();
    const eventRepo = source.getRepository(NoticeChangeEvent);
    for (let noticeNum = 1; noticeNum <= 4; noticeNum++) {
      const built = buildDiffEvent({
        noticeNum,
        beforeSnapshot: null,
        afterSnapshot: {
          ...Object.fromEntries(
            getTrackedFieldsForCanonVersion(2).map((field) => [field, null]),
          ),
          num: noticeNum,
          subject: '법률안',
          proposalReason: '',
        },
        detectedAt: new Date('2026-01-01T00:00:00Z'),
        source: NoticeChangeSource.ARCHIVE_UPSERT,
      });
      const event = await eventRepo.save(
        eventRepo.create({
          noticeNum,
          detectedAt: built.detectedAt,
          eventType: built.eventType,
          source: NoticeChangeSource.ARCHIVE_UPSERT,
          eventHeight: 1,
          prevEventHash: null,
          eventHash: built.eventHash,
          changedFieldCount: built.diff.changedFieldCount,
          diffSummaryJson: built.diff.diffSummaryJson,
          hashAlgo: built.hashAlgo,
          canonVersion: built.canonVersion,
        }),
      );
      await source.getRepository(NoticeChangeDetail).save(
        built.diff.details.map((detail) => ({
          ...detail,
          eventId: event.id,
        })),
      );
    }
  });

  afterEach(async () => {
    if (source?.isInitialized) await source.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const runChild = (
    database: string,
    signal = new AbortController().signal,
    timeoutMs = 15_000,
  ) =>
    superviseChainAuditChild({
      entrypoint: path.join(__dirname, 'chain-audit-child.ts'),
      database,
      scope: 'daily',
      signal,
      limits: { ...readChainAuditLimits({}), timeoutMs, dutyPercent: 50 },
    });

  const inline = (source: DataSource, maxFailureDetails?: number) =>
    runScheduledChainAuditInternal(
      {
        changeEventRepository: source.getRepository(NoticeChangeEvent),
        changeDetailRepository: source.getRepository(NoticeChangeDetail),
        archiveRepository: source.getRepository(NoticeArchive),
        baselineEventHeight: 1,
        logger: { log() {}, error() {} },
        buildDiffEvent,
        maxFailureDetails,
      },
      'daily',
    );

  it('matches the original checkpoint while the parent event loop keeps ticking and the DB stays unchanged', async () => {
    const baseline = await inline(source);
    const before = await source.query(
      'SELECT * FROM notice_change_events ORDER BY id',
    );
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 5);
    let report;
    try {
      report = await runChild(database);
    } finally {
      clearInterval(timer);
    }
    expect(report).toEqual({ ...baseline, checkedAt: expect.any(String) });
    expect(report.failureCount).toBe(0);
    expect(ticks).toBeGreaterThan(5);
    expect(
      await source.query('SELECT * FROM notice_change_events ORDER BY id'),
    ).toEqual(before);
  });

  it('detects corruption without losing total failures or checkpoint when samples are capped', async () => {
    const details = source.getRepository(NoticeChangeDetail);
    const eventId = (await source.getRepository(NoticeChangeEvent).find())[0]
      .id;
    await details.save(
      Array.from({ length: 150 }, (_, index) => ({
        eventId,
        fieldPath: `corrupted${index}`,
        changeType: 'added' as const,
        beforeValue: null,
        afterValue: 'broken',
        beforeHash: null,
        afterHash: 'bad',
      })),
    );
    const baseline = await inline(source);
    const capped = await inline(source, 100);
    const report = await runChild(database);
    expect(report.failureCount).toBeGreaterThan(100);
    expect(report.failureCount).toBe(baseline.failureCount);
    expect(report.checkpointRootHash).toBe(baseline.checkpointRootHash);
    expect(report.failures).toHaveLength(100);
    expect(capped.checkpointRootHash).toBe(baseline.checkpointRootHash);
  });

  it('enforces the cooperative RSS budget in the actual child', async () => {
    await expect(
      superviseChainAuditChild({
        entrypoint: path.join(__dirname, 'chain-audit-child.ts'),
        database,
        scope: 'daily',
        signal: new AbortController().signal,
        limits: { ...readChainAuditLimits({}), rssMb: 1 },
      }),
    ).rejects.toThrow('RSS budget exceeded');
  });

  it('reads long chains in bounded detail batches without losing issues', async () => {
    const repo = source.getRepository(NoticeChangeEvent);
    const template = (await repo.find({ where: { noticeNum: 1 } }))[0];
    await source.transaction(async (manager) => {
      for (let height = 2; height <= 502; height++) {
        const { id: _id, ...base } = template;
        await manager.getRepository(NoticeChangeEvent).save({
          ...base,
          eventHeight: height,
          eventHash: String(height).padStart(64, '0'),
          prevEventHash: 'bad',
        });
      }
    });
    const baseline = await inline(source);
    const report = await runChild(database);
    expect(report.eventCount).toBe(505);
    expect(report.failureCount).toBe(baseline.failureCount);
    expect(report.checkpointRootHash).toBe(baseline.checkpointRootHash);
    expect(report.failures).toHaveLength(100);
  });

  it('fails rather than creating a missing source database', async () => {
    await expect(
      runChild(path.join(directory, 'missing.sqlite')),
    ).rejects.toThrow();
  });

  it('kills and reaps an expired child before rejecting, then permits another audit', async () => {
    await expect(runChild(database, undefined, 1)).rejects.toThrow('exceeded');
    await expect(runChild(database)).resolves.toMatchObject({
      failureCount: 0,
    });
  });

  it('cancels an active child and rejects an already aborted request', async () => {
    const controller = new AbortController();
    const pending = runChild(database, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    await expect(runChild(database, controller.signal)).rejects.toThrow(
      'cancelled',
    );
  });
});
