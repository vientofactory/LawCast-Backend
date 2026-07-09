import { In, type Repository } from 'typeorm';
import {
  NoticeChangeEvent,
  type ChangeEventType,
} from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';
import { type NoticeChangeSource } from './notice-change-source.enum';
import {
  canonicalStringify,
  DEFAULT_TRACKED_FIELDS,
  sha256Hex,
  type DiffComputationResult,
} from './change-tracking-diff.utils';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { type DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { type ChangeChainAuditReport } from './change-tracking.service';
import { logAndBridge } from '../../utils/bridge-log.utils';

interface ChainVerificationIssue {
  noticeNum: number;
  eventId?: number;
  eventHeight?: number;
  code: string;
  message: string;
}

interface ChainVerificationReport {
  noticeNum: number;
  eventCount: number;
  latestEventHash: string | null;
  issues: ChainVerificationIssue[];
}

interface BuildDiffEventOutput {
  eventType: ChangeEventType;
  eventHash: string;
  diff: DiffComputationResult;
}

interface BuildDiffEventInput {
  noticeNum: number;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown>;
  detectedAt?: Date;
  source?: NoticeChangeSource | null;
  trackedFields?: readonly string[];
  hashAlgo?: string;
  canonVersion?: number;
}

export interface ChangeTrackingChainAuditDeps {
  changeEventRepository: Repository<NoticeChangeEvent>;
  changeDetailRepository: Repository<NoticeChangeDetail>;
  baselineEventHeight: number;
  logger: { log(message: string): void; error(message: string): void };
  buildDiffEvent(input: BuildDiffEventInput): BuildDiffEventOutput;
  discordBridge?: DiscordBridgeService;
}

export async function runScheduledChainAuditInternal(
  deps: ChangeTrackingChainAuditDeps,
  scope: 'daily' | 'weekly',
): Promise<ChangeChainAuditReport> {
  const reports = await verifyAllChains(deps);
  const failures = reports.flatMap((report) => report.issues);
  const checkpointRootHash = computeCheckpointRootHash(reports);
  const result: ChangeChainAuditReport = {
    checkedAt: new Date().toISOString(),
    scope,
    noticeCount: reports.length,
    eventCount: reports.reduce((sum, report) => sum + report.eventCount, 0),
    failureCount: failures.length,
    checkpointRootHash,
    failures,
  };

  const summaryMessage =
    `Change-chain ${scope} audit completed: ` +
    `${result.noticeCount} notice(s), ${result.eventCount} event(s), ` +
    `${result.failureCount} failure(s), checkpoint=${checkpointRootHash}`;

  if (result.failureCount > 0) {
    logAndBridge({
      logger: deps.logger,
      method: 'error',
      message: summaryMessage,
      context: 'ChangeTrackingService',
      discordBridge: deps.discordBridge,
      bridgeLevel: BridgeLogLevel.ERROR,
      metadata: {
        scope,
        checkpointRootHash,
        failures: failures.slice(0, 20),
      },
    });
  } else {
    logAndBridge({
      logger: deps.logger,
      method: 'log',
      message: summaryMessage,
      context: 'ChangeTrackingService',
      discordBridge: deps.discordBridge,
      bridgeLevel: BridgeLogLevel.LOG,
      metadata: {
        scope,
        checkpointRootHash,
        noticeCount: result.noticeCount,
        eventCount: result.eventCount,
      },
    });
  }

  return result;
}

async function verifyAllChains(
  deps: ChangeTrackingChainAuditDeps,
): Promise<ChainVerificationReport[]> {
  const rawNoticeNums = await deps.changeEventRepository
    .createQueryBuilder('event')
    .select('DISTINCT event.noticeNum', 'noticeNum')
    .orderBy('event.noticeNum', 'ASC')
    .getRawMany<{ noticeNum: number | string }>();

  const reports: ChainVerificationReport[] = [];
  for (const raw of rawNoticeNums) {
    reports.push(await verifyNoticeChain(deps, Number(raw.noticeNum)));
  }

  return reports;
}

async function verifyNoticeChain(
  deps: ChangeTrackingChainAuditDeps,
  noticeNum: number,
): Promise<ChainVerificationReport> {
  const events = await deps.changeEventRepository.find({
    where: { noticeNum },
    order: { eventHeight: 'ASC', id: 'ASC' },
  });
  const eventIds = events.map((event) => event.id);
  const details = eventIds.length
    ? await deps.changeDetailRepository.find({
        where: { eventId: In(eventIds) },
        order: { id: 'ASC' },
      })
    : [];

  const detailsByEventId = new Map<number, NoticeChangeDetail[]>();
  for (const detail of details) {
    const bucket = detailsByEventId.get(detail.eventId) ?? [];
    bucket.push(detail);
    detailsByEventId.set(detail.eventId, bucket);
  }

  const issues: ChainVerificationIssue[] = [];
  let previousHash: string | null = null;
  let currentState = createEmptyTrackedState();

  events.forEach((event, index) => {
    const eventDetails = detailsByEventId.get(event.id) ?? [];
    const beforeState = index === 0 ? null : { ...currentState };
    const nextState = applyDetailsToTrackedState(currentState, eventDetails);
    const rebuilt = deps.buildDiffEvent({
      noticeNum,
      beforeSnapshot: beforeState,
      afterSnapshot: nextState,
      detectedAt: event.detectedAt,
      source: event.source,
      trackedFields: DEFAULT_TRACKED_FIELDS,
      hashAlgo: event.hashAlgo,
      canonVersion: event.canonVersion,
    });

    if (event.eventHeight !== index + 1) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: 'event_height_gap',
        message: `Expected event height ${index + 1} but found ${event.eventHeight}`,
      });
    }

    const expectedPrevHash = event.eventHeight === 1 ? null : previousHash;
    if ((event.prevEventHash ?? null) !== expectedPrevHash) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: 'prev_hash_mismatch',
        message: `Expected prev_event_hash ${expectedPrevHash ?? 'null'} but found ${event.prevEventHash ?? 'null'}`,
      });
    }

    if (event.eventHash !== rebuilt.eventHash) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: 'event_hash_mismatch',
        message:
          'Stored event hash does not match the reconstructed canonical event hash',
      });
    }

    if (event.eventType !== rebuilt.eventType) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: 'event_type_mismatch',
        message: `Expected event type ${rebuilt.eventType} but found ${event.eventType}`,
      });
    }

    if (event.changedFieldCount !== rebuilt.diff.changedFieldCount) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: 'changed_field_count_mismatch',
        message: `Expected changedFieldCount ${rebuilt.diff.changedFieldCount} but found ${event.changedFieldCount}`,
      });
    }

    if ((event.diffSummaryJson ?? null) !== rebuilt.diff.diffSummaryJson) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: 'diff_summary_mismatch',
        message:
          'Stored diff summary does not match the reconstructed diff summary',
      });
    }

    for (const detail of eventDetails) {
      const expectedBeforeHash =
        detail.beforeValue === null ? null : sha256Hex(detail.beforeValue);
      const expectedAfterHash =
        detail.afterValue === null ? null : sha256Hex(detail.afterValue);

      if ((detail.beforeHash ?? null) !== expectedBeforeHash) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: 'detail_before_hash_mismatch',
          message: `before_hash mismatch on field ${detail.fieldPath}`,
        });
      }

      if ((detail.afterHash ?? null) !== expectedAfterHash) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: 'detail_after_hash_mismatch',
          message: `after_hash mismatch on field ${detail.fieldPath}`,
        });
      }
    }

    currentState = nextState;
    previousHash = event.eventHash;
  });

  return {
    noticeNum,
    eventCount: events.length,
    latestEventHash: previousHash,
    issues,
  };
}

function createEmptyTrackedState(): Record<string, unknown> {
  return Object.fromEntries(
    DEFAULT_TRACKED_FIELDS.map((fieldPath) => [fieldPath, null]),
  ) as Record<string, unknown>;
}

function applyDetailsToTrackedState(
  previousState: Record<string, unknown>,
  details: NoticeChangeDetail[],
): Record<string, unknown> {
  const nextState = { ...previousState };

  for (const detail of details) {
    nextState[detail.fieldPath] = coerceTrackedFieldValue(
      detail.fieldPath,
      detail.afterValue,
    );
  }

  return nextState;
}

function coerceTrackedFieldValue(
  fieldPath: string,
  value: string | null,
): unknown {
  if (value === null) {
    return null;
  }

  if (fieldPath === 'num') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : value;
  }

  if (fieldPath === 'isDone') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return value;
}

function computeCheckpointRootHash(reports: ChainVerificationReport[]): string {
  return sha256Hex(
    canonicalStringify(
      reports.map((report) => ({
        noticeNum: report.noticeNum,
        eventCount: report.eventCount,
        latestEventHash: report.latestEventHash,
        issueCount: report.issues.length,
      })),
    ),
  );
}
