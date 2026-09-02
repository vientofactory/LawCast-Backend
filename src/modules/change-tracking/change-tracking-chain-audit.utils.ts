import { In, type Repository } from 'typeorm';
import {
  NoticeChangeEvent,
  type ChangeEventType,
} from './notice-change-event.entity';
import { NoticeChangeDetail } from './notice-change-detail.entity';
import { type NoticeChangeSource } from './notice-change-source.enum';
import {
  canonicalStringify,
  canonicalizeChangeSnapshotForSource,
  getTrackedFieldsForChangeEvent,
  sha256Hex,
  type DiffComputationResult,
} from './change-tracking-diff.utils';
import { BridgeLogLevel } from '../discord-bridge/discord-bridge.types';
import { type DiscordBridgeService } from '../discord-bridge/discord-bridge.service';
import { type ChangeChainAuditReport } from './change-tracking.service';
import { logAndBridge } from '../../utils/bridge-log.utils';
import { NoticeArchive } from '../notice/notice-archive.entity';

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

interface LegacyHashCompatibilityInput {
  event: NoticeChangeEvent;
  rebuilt: BuildDiffEventOutput;
  eventDetails: NoticeChangeDetail[];
}

export interface ChangeTrackingChainAuditDeps {
  changeEventRepository: Repository<NoticeChangeEvent>;
  changeDetailRepository: Repository<NoticeChangeDetail>;
  archiveRepository?: Repository<NoticeArchive>;
  baselineEventHeight: number;
  logger: { log(message: string): void; error(message: string): void };
  buildDiffEvent(input: BuildDiffEventInput): BuildDiffEventOutput;
  discordBridge?: DiscordBridgeService;
}

export enum ChainVerificationErrorCode {
  EventHeightGap = 'event_height_gap',
  PrevHashMismatch = 'prev_hash_mismatch',
  EventHashMismatch = 'event_hash_mismatch',
  EventTypeMismatch = 'event_type_mismatch',
  ChangedFieldCountMismatch = 'changed_field_count_mismatch',
  DiffSummaryMismatch = 'diff_summary_mismatch',
  DetailBeforeHashMismatch = 'detail_before_hash_mismatch',
  DetailAfterHashMismatch = 'detail_after_hash_mismatch',
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

function isLegacyCanonicalHashCompatible(
  input: LegacyHashCompatibilityInput,
): boolean {
  if (input.event.eventType !== input.rebuilt.eventType) {
    return false;
  }

  if (input.event.changedFieldCount !== input.rebuilt.diff.changedFieldCount) {
    return false;
  }

  if (
    (input.event.diffSummaryJson ?? null) !== input.rebuilt.diff.diffSummaryJson
  ) {
    return false;
  }

  if (input.eventDetails.length !== input.rebuilt.diff.details.length) {
    return false;
  }

  const expectedByField = new Map(
    input.rebuilt.diff.details.map((detail) => [detail.fieldPath, detail]),
  );

  for (const detail of input.eventDetails) {
    const expected = expectedByField.get(detail.fieldPath);
    if (!expected) {
      return false;
    }

    if (detail.changeType !== expected.changeType) {
      return false;
    }

    if ((detail.beforeValue ?? null) !== (expected.beforeValue ?? null)) {
      return false;
    }

    if ((detail.afterValue ?? null) !== (expected.afterValue ?? null)) {
      return false;
    }

    if ((detail.beforeHash ?? null) !== (expected.beforeHash ?? null)) {
      return false;
    }

    if ((detail.afterHash ?? null) !== (expected.afterHash ?? null)) {
      return false;
    }
  }

  return true;
}

function buildAuditSeedSnapshot(row: NoticeArchive): Record<string, unknown> {
  return {
    num: row.noticeNum,
    contentId: row.contentId ?? null,
    subject: row.subject,
    proposerCategory: row.proposerCategory,
    committee: row.committee,
    proposalReason: row.proposalReason,
    billNumber: row.contentBillNumber,
    proposer: row.contentProposer,
    proposalDate: row.contentProposalDate,
    contentCommittee: row.contentCommittee,
    referralDate: row.contentReferralDate,
    noticePeriod: row.contentNoticePeriod,
    proposalSession: row.contentProposalSession,
    isDone: false,
    lifecycleStatus: row.lifecycleStatus,
    sourceDeletedAt: row.sourceDeletedAt
      ? row.sourceDeletedAt.toISOString()
      : null,
  };
}

async function verifyAllChains(
  deps: ChangeTrackingChainAuditDeps,
): Promise<ChainVerificationReport[]> {
  const rawNoticeNums = await deps.changeEventRepository
    .createQueryBuilder('event')
    .select('DISTINCT event.noticeNum', 'noticeNum')
    .orderBy('event.noticeNum', 'ASC')
    .getRawMany<{ noticeNum: number | string }>();

  const noticeNums = rawNoticeNums.map((r) => Number(r.noticeNum));

  // Pre-fetch archive rows to seed initial state for each chain.
  // The write path (buildDiffBaselineSnapshot) starts from the DB row,
  // so the audit must do the same to reproduce stored hashes.
  const archiveSnapshotByNum = new Map<number, Record<string, unknown>>();
  if (deps.archiveRepository && noticeNums.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < noticeNums.length; i += BATCH) {
      const batch = noticeNums.slice(i, i + BATCH);
      const rows = await deps.archiveRepository.find({
        where: { noticeNum: In(batch) } as any,
        select: [
          'noticeNum',
          'contentId',
          'subject',
          'proposerCategory',
          'committee',
          'proposalReason',
          'contentBillNumber',
          'contentProposer',
          'contentProposalDate',
          'contentCommittee',
          'contentReferralDate',
          'contentNoticePeriod',
          'contentProposalSession',
          'lifecycleStatus',
          'sourceDeletedAt',
        ],
      });
      for (const row of rows) {
        archiveSnapshotByNum.set(row.noticeNum, buildAuditSeedSnapshot(row));
      }
    }
  }

  const reports: ChainVerificationReport[] = [];
  for (const noticeNum of noticeNums) {
    const seedSnapshot = archiveSnapshotByNum.get(noticeNum) ?? null;
    const result = await verifyNoticeChain(deps, noticeNum, seedSnapshot);
    reports.push(result);
  }

  return reports;
}

async function verifyNoticeChain(
  deps: ChangeTrackingChainAuditDeps,
  noticeNum: number,
  seedSnapshot: Record<string, unknown> | null = null,
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
  // A chain whose v1 archive:upsert events carry contentId details was written
  // during the window where contentId was already tracked but the canonVersion
  // column did not exist yet. Such events were diffed with DEFAULT_TRACKED_FIELDS
  // (contentId included) but hashed from raw snapshots without the archive
  // upsert canonicalization that canon v2 introduced later, so the audit must
  // mirror exactly that: contentId in the state shape, no snapshot
  // canonicalization for the v1 segment.
  const hasPreVersionedArchiveUpsert = events.some((event) => {
    if ((event.canonVersion ?? 1) > 1 || event.source !== 'archive:upsert') {
      return false;
    }

    const eventDetails = detailsByEventId.get(event.id) ?? [];
    return eventDetails.some((detail) => detail.fieldPath === 'contentId');
  });
  let previousHash: string | null = null;
  // Seed from the current archive row to match the write path
  // (buildDiffBaselineSnapshot), which starts from the DB row and
  // overlays chain history. Without this, fields added to the schema
  // after earlier events (e.g. contentId in v2) would be null in the
  // audit while the write path used the DB row value.
  //
  // The seed must never win over the chain's own recorded history: a field
  // that some event in this chain explicitly records (e.g. lifecycleStatus /
  // sourceDeletedAt turning non-null on a later source_deleted event) has to
  // start unset/null and be reconstructed purely by replaying events in
  // order. Otherwise a field whose real transition happens at height N leaks
  // backward into height 1..N-1's reconstructed state as soon as the archive
  // row reflects that later value (e.g. after immutable-trigger reconciliation),
  // inflating changedFieldCount/diffSummary/eventHash for every earlier event.
  const fieldsTouchedByChain = new Set<string>();
  for (const detail of details) {
    fieldsTouchedByChain.add(detail.fieldPath);
  }
  const initialSeed = { ...(seedSnapshot ?? {}) };
  for (const fieldPath of fieldsTouchedByChain) {
    delete initialSeed[fieldPath];
  }
  let currentState: Record<string, unknown> = initialSeed;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const eventDetails = detailsByEventId.get(event.id) ?? [];
    const canonVersion = event.canonVersion ?? 1;
    const usePreVersionedArchiveUpsert =
      hasPreVersionedArchiveUpsert &&
      event.source === 'archive:upsert' &&
      canonVersion <= 1;
    const trackedFields = getTrackedFieldsForChangeEvent({
      source: event.source,
      canonVersion,
      preVersionedArchiveUpsert: usePreVersionedArchiveUpsert,
    });
    currentState = ensureTrackedStateFields(
      currentState,
      trackedFields,
      canonVersion,
    );
    const beforeState = index === 0 ? null : { ...currentState };
    const nextState = applyDetailsToTrackedState(currentState, eventDetails);
    const rebuilt = deps.buildDiffEvent({
      noticeNum,
      beforeSnapshot: canonicalizeChangeSnapshotForSource(
        event.source,
        canonVersion,
        beforeState,
      ),
      afterSnapshot:
        canonicalizeChangeSnapshotForSource(
          event.source,
          canonVersion,
          nextState,
        ) ?? nextState,
      detectedAt: event.detectedAt,
      source: event.source,
      trackedFields,
      hashAlgo: event.hashAlgo,
      canonVersion,
    });

    if (event.eventHeight !== index + 1) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: ChainVerificationErrorCode.EventHeightGap,
        message: `Expected event height ${index + 1} but found ${event.eventHeight}`,
      });
    }

    const isLegacyCompatible =
      (event.canonVersion ?? 1) <= 1 &&
      event.eventHash !== rebuilt.eventHash &&
      isLegacyCanonicalHashCompatible({
        event,
        rebuilt,
        eventDetails,
      });

    const expectedPrevHash = event.eventHeight === 1 ? null : previousHash;
    if (
      (event.prevEventHash ?? null) !== expectedPrevHash &&
      !isLegacyCompatible
    ) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: ChainVerificationErrorCode.PrevHashMismatch,
        message: `Expected prev_event_hash ${expectedPrevHash ?? 'null'} but found ${event.prevEventHash ?? 'null'}`,
      });
    }

    if (event.eventHash !== rebuilt.eventHash && !isLegacyCompatible) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: ChainVerificationErrorCode.EventHashMismatch,
        message:
          'Stored event hash does not match the reconstructed canonical event hash',
      });
    }

    if (event.eventType !== rebuilt.eventType) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: ChainVerificationErrorCode.EventTypeMismatch,
        message: `Expected event type ${rebuilt.eventType} but found ${event.eventType}`,
      });
    }

    if (event.changedFieldCount !== rebuilt.diff.changedFieldCount) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: ChainVerificationErrorCode.ChangedFieldCountMismatch,
        message: `Expected changedFieldCount ${rebuilt.diff.changedFieldCount} but found ${event.changedFieldCount}`,
      });
    }

    if ((event.diffSummaryJson ?? null) !== rebuilt.diff.diffSummaryJson) {
      issues.push({
        noticeNum,
        eventId: event.id,
        eventHeight: event.eventHeight,
        code: ChainVerificationErrorCode.DiffSummaryMismatch,
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
          code: ChainVerificationErrorCode.DetailBeforeHashMismatch,
          message: `before_hash mismatch on field ${detail.fieldPath}`,
        });
      }

      if ((detail.afterHash ?? null) !== expectedAfterHash) {
        issues.push({
          noticeNum,
          eventId: event.id,
          eventHeight: event.eventHeight,
          code: ChainVerificationErrorCode.DetailAfterHashMismatch,
          message: `after_hash mismatch on field ${detail.fieldPath}`,
        });
      }
    }

    currentState = nextState;
    previousHash = event.eventHash;
  }

  return {
    noticeNum,
    eventCount: events.length,
    latestEventHash: previousHash,
    issues,
  };
}

function ensureTrackedStateFields(
  state: Record<string, unknown>,
  trackedFields: readonly string[],
  canonVersion: number,
): Record<string, unknown> {
  const nextState = { ...state };
  for (const fieldPath of trackedFields) {
    if (Object.prototype.hasOwnProperty.call(nextState, fieldPath)) {
      continue;
    }

    // proposalReason is a NOT NULL DEFAULT '' column, so write-time snapshots
    // always carried '' (never null) for empty reasons. Since canon v2 compares
    // proposalReason semantically ('' ≡ null), empty rows record no detail and
    // the audit must seed '' instead of null to reproduce the stored hash.
    nextState[fieldPath] =
      canonVersion >= 2 && fieldPath === 'proposalReason' ? '' : null;
  }
  return nextState;
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
