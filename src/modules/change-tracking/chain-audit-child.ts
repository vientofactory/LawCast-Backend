import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import { constants, setPriority } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { NoticeArchive } from '../notice/notice-archive.entity';
import { NoticeChangeEvent } from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';
import { buildDiffEvent } from './change-tracking-event-builder';
import { runScheduledChainAuditInternal } from './change-tracking-chain-audit.utils';
import {
  MAX_AUDIT_FAILURES,
  type ChainAuditLimits,
} from './chain-audit-limits';

async function audit() {
  if (!process.send) throw new Error('Chain audit requires IPC');
  const [database, scope, limitsJson] = process.argv.slice(2);
  if (scope !== 'daily' && scope !== 'weekly')
    throw new Error('Invalid audit scope');
  const limits = JSON.parse(limitsJson) as ChainAuditLimits;
  // Lower scheduler priority complements cooperative CPU/I/O pacing.
  try {
    setPriority(0, constants.priority.PRIORITY_LOW);
  } catch (error) {
    // Some hosts deny priority changes; mandatory pacing still bounds work slices.
    if (
      !['EPERM', 'EACCES', 'ENOSYS'].includes(
        (error as { info?: { code?: string } }).info?.code ??
          (error as NodeJS.ErrnoException).code ??
          '',
      )
    )
      throw error;
  }
  const source = new DataSource({
    type: 'better-sqlite3',
    database,
    readonly: true,
    fileMustExist: true,
    synchronize: false,
    migrationsRun: false,
    entities: [NoticeArchive, NoticeChangeEvent, NoticeChangeDetail],
    statementCacheSize: 16,
    timeout: 1000,
    prepareDatabase(db) {
      db.pragma('query_only = ON');
      db.pragma('cache_size = -8192');
      db.pragma('mmap_size = 0');
      db.pragma('temp_store = FILE');
    },
  });
  let sliceStart = performance.now();
  const pace = async () => {
    if (process.memoryUsage.rss() > limits.rssMb * 1024 * 1024) {
      throw new Error('Chain audit RSS budget exceeded');
    }
    const workMs = performance.now() - sliceStart;
    // Rest after bounded reads/replays, not just once after the entire audit.
    await sleep(
      Math.max(5, Math.ceil(workMs * (100 / limits.dutyPercent - 1))),
    );
    sliceStart = performance.now();
  };
  await source.initialize();
  try {
    // A single read snapshot prevents concurrent appends from mixing event/detail versions.
    // The supervisor deadline also bounds this reader's WAL retention lifetime.
    await source.query('BEGIN');
    try {
      return await runScheduledChainAuditInternal(
        {
          changeEventRepository: source.getRepository(NoticeChangeEvent),
          changeDetailRepository: source.getRepository(NoticeChangeDetail),
          archiveRepository: source.getRepository(NoticeArchive),
          baselineEventHeight: 1,
          logger: { log() {}, error() {} },
          buildDiffEvent,
          batchSize: limits.batchSize,
          maxFailureDetails: MAX_AUDIT_FAILURES,
          pace,
        },
        scope,
      );
    } finally {
      await source.query('ROLLBACK');
    }
  } finally {
    await source.destroy();
  }
}

// Never keep an orphaned reader alive if the supervising process disappears.
const parentDisconnected = () => process.exit(1);
process.on('disconnect', parentDisconnected);
const disconnect = () => {
  process.removeListener('disconnect', parentDisconnected);
  process.disconnect();
};
void audit().then(
  (report) => {
    process.send?.({ type: 'result', report }, disconnect);
  },
  (error: unknown) => {
    process.exitCode = 1;
    process.send?.(
      { type: 'failure', message: String(error).slice(0, 1024) },
      disconnect,
    );
  },
);
