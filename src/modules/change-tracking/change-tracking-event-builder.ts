import {
  CHANGE_EVENT_TYPE,
  type ChangeEventType,
} from './notice-change-event.entity';
import { NOTICE_LIFECYCLE_STATUS } from '../notice/notice-archive.entity';
import { type NoticeChangeSource } from './notice-change-source.enum';
import {
  canonicalStringify,
  computeDiff,
  CURRENT_CANON_VERSION,
  getTrackedFieldsForCanonVersion,
  sha256Hex,
  type DiffComputationResult,
} from './change-tracking-diff.utils';

export interface BuildDiffEventInput {
  noticeNum: number;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown>;
  detectedAt?: Date;
  source?: NoticeChangeSource | null;
  trackedFields?: readonly string[];
  hashAlgo?: string;
  canonVersion?: number;
  preferredEventType?: ChangeEventType;
}

export interface BuildDiffEventOutput {
  shouldAppend: boolean;
  eventType: ChangeEventType;
  diff: DiffComputationResult;
  eventHash: string;
  detectedAt: Date;
  hashAlgo: string;
  canonVersion: number;
}

export function buildDiffEvent(
  input: BuildDiffEventInput,
): BuildDiffEventOutput {
  const hashAlgo = input.hashAlgo ?? 'sha256';
  const canonVersion = input.canonVersion ?? CURRENT_CANON_VERSION;
  const detectedAt = input.detectedAt ?? new Date();

  const diff = computeDiff(
    input.beforeSnapshot,
    input.afterSnapshot,
    input.trackedFields ?? getTrackedFieldsForCanonVersion(canonVersion),
    canonVersion,
  );

  const eventType = resolveEventType(input);

  // For non-created events, append only when tracked fields changed.
  const shouldAppend = eventType === CHANGE_EVENT_TYPE.CREATED || diff.changed;

  const hashPayload = canonicalStringify({
    noticeNum: input.noticeNum,
    detectedAt: detectedAt.toISOString(),
    eventType,
    source: input.source ?? null,
    hashAlgo,
    canonVersion,
    before: diff.normalizedBefore,
    after: diff.normalizedAfter,
    details: diff.details,
  });

  const eventHash = sha256Hex(hashPayload);

  return {
    shouldAppend,
    eventType,
    diff,
    eventHash,
    detectedAt,
    hashAlgo,
    canonVersion,
  };
}

function resolveEventType(input: BuildDiffEventInput): ChangeEventType {
  if (input.beforeSnapshot === null) {
    return CHANGE_EVENT_TYPE.CREATED;
  }

  if (input.preferredEventType) {
    return input.preferredEventType;
  }

  const lifecycleStatus =
    typeof input.afterSnapshot.lifecycleStatus === 'string'
      ? input.afterSnapshot.lifecycleStatus.trim().toLowerCase()
      : '';
  const sourceDeletedAt = input.afterSnapshot.sourceDeletedAt;
  const hasSourceDeletedAt =
    sourceDeletedAt !== null &&
    sourceDeletedAt !== undefined &&
    String(sourceDeletedAt).trim().length > 0;

  if (
    lifecycleStatus === NOTICE_LIFECYCLE_STATUS.SOURCE_DELETED ||
    lifecycleStatus === NOTICE_LIFECYCLE_STATUS.RENUMBERED ||
    lifecycleStatus === 'invalidated' ||
    hasSourceDeletedAt
  ) {
    return CHANGE_EVENT_TYPE.INVALIDATED;
  }

  return CHANGE_EVENT_TYPE.UPDATED;
}
