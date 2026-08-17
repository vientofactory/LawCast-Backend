import { createHash } from 'crypto';
import { type ChangeDetailType } from './notice-change-detail.entity';
import {
  canonicalizeProposalReason,
  canonicalizeProposalReasonForComparison,
} from '../../utils/proposal-reason.utils';
import { type NoticeChangeSource } from './notice-change-source.enum';

export interface DiffDetail {
  fieldPath: string;
  changeType: ChangeDetailType;
  beforeValue: string | null;
  afterValue: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface DiffComputationResult {
  changed: boolean;
  changedFieldCount: number;
  details: DiffDetail[];
  normalizedBefore: Record<string, unknown> | null;
  normalizedAfter: Record<string, unknown>;
  diffSummaryJson: string;
}

export const CURRENT_CANON_VERSION = 2;

// Canon v1 predates contentId tracking and compares preserved proposalReason
// line layouts literally. Never mutate this list: historical hashes depend on it.
export const LEGACY_TRACKED_FIELDS_V1 = [
  'num',
  'subject',
  'proposerCategory',
  'committee',
  'proposalReason',
  'billNumber',
  'proposer',
  'proposalDate',
  'contentCommittee',
  'referralDate',
  'noticePeriod',
  'proposalSession',
  'isDone',
  'lifecycleStatus',
  'sourceDeletedAt',
] as const;

// Track only user-meaningful notice metadata and proposal text.
export const DEFAULT_TRACKED_FIELDS = [
  'num',
  'contentId',
  ...LEGACY_TRACKED_FIELDS_V1.slice(1),
] as const;

export function getTrackedFieldsForCanonVersion(
  canonVersion: number,
): readonly string[] {
  return canonVersion <= 1 ? LEGACY_TRACKED_FIELDS_V1 : DEFAULT_TRACKED_FIELDS;
}

// Pre-versioned archive:upsert events (contentId tracked before the
// canonVersion column existed) were diffed against DEFAULT_TRACKED_FIELDS, so
// the audit replays them with contentId in the tracked state shape. Note that
// this only affects diff/state reconstruction: snapshot canonicalization is
// still gated on canonVersion >= 2 because those events were hashed from raw
// snapshots (see canonicalizeChangeSnapshotForSource).
export function getTrackedFieldsForChangeEvent(input: {
  source: NoticeChangeSource | null | undefined;
  canonVersion: number;
  preVersionedArchiveUpsert: boolean;
}): readonly string[] {
  if (
    input.preVersionedArchiveUpsert &&
    input.source === 'archive:upsert' &&
    input.canonVersion <= 1
  ) {
    return DEFAULT_TRACKED_FIELDS;
  }

  return getTrackedFieldsForCanonVersion(input.canonVersion);
}

export function canonicalizeArchiveUpsertSnapshot(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!snapshot) {
    return snapshot;
  }

  const normalized = { ...snapshot };
  normalized.subject = canonicalizeTrackedSubject(normalized.subject);
  normalized.proposalDate = canonicalizeTrackedProposalDate(
    normalized.proposalDate,
  );
  normalized.proposalSession = canonicalizeTrackedProposalSession(
    normalized.proposalSession,
  );

  return normalized;
}

// Snapshot canonicalization (sponsor-suffix stripping, date/session
// normalization) was introduced together with canon v2 in the same release.
// Pre-versioned v1 events (canonVersion=1) were hashed from raw snapshots, so
// the audit must never canonicalize them even when the chain recorded
// contentId details before the canonVersion column existed.
export function canonicalizeChangeSnapshotForSource(
  source: NoticeChangeSource | null | undefined,
  canonVersion: number,
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (source === 'archive:upsert' && canonVersion >= 2) {
    return canonicalizeArchiveUpsertSnapshot(snapshot);
  }

  return snapshot;
}

function canonicalizeTrackedSubject(value: unknown): string | null {
  const normalized =
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
  if (!normalized) {
    return null;
  }

  const withoutSponsorSuffix = normalized.replace(
    /\s*\([^()]*의원\s+등\s+\d+인\)\s*$/u,
    '',
  );
  return withoutSponsorSuffix.trim() || normalized;
}

function canonicalizeTrackedProposalDate(value: unknown): string | null {
  const normalized =
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
  if (!normalized) {
    return null;
  }

  const dotted = normalized.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.$/);
  if (dotted) {
    const [, year, month, day] = dotted;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const dashed = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dashed) {
    const [, year, month, day] = dashed;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return normalized;
}

function canonicalizeTrackedProposalSession(value: unknown): string | null {
  const normalized =
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
  if (!normalized) {
    return null;
  }

  const sessionMatch = normalized.match(/제\s*(\d+)\s*회/u);
  return sessionMatch ? `제${sessionMatch[1]}회` : normalized;
}

function normalizeString(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeTrackedString(fieldPath: string, input: string): string {
  if (fieldPath === 'proposalReason') {
    return canonicalizeProposalReason(input) ?? '';
  }
  return normalizeString(input);
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const normalized: Record<string, unknown> = {};

    for (const key of keys) {
      normalized[key] = normalizeValue(obj[key]);
    }

    return normalized;
  }

  if (typeof value === 'string') {
    return normalizeString(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return true;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const keys = Object.keys(value).sort();
  const output: Record<string, unknown> = {};

  for (const key of keys) {
    output[key] = canonicalize(value[key]);
  }

  return output;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(normalizeValue(value)));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function getPathValue(source: Record<string, unknown>, path: string): unknown {
  const tokens = path.split('.');
  let current: unknown = source;

  for (const token of tokens) {
    if (!isPlainObject(current)) {
      return null;
    }
    current = current[token];
  }

  return current ?? null;
}

function toComparableString(value: unknown, fieldPath: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return normalizeTrackedString(fieldPath, value);
  }

  return canonicalStringify(value);
}

function hashComparable(value: string | null): string | null {
  if (value === null) return null;
  return sha256Hex(value);
}

export function normalizeSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeValue(snapshot) as Record<string, unknown>;
}

export function computeDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  trackedFields: readonly string[] = DEFAULT_TRACKED_FIELDS,
  canonVersion = CURRENT_CANON_VERSION,
): DiffComputationResult {
  const normalizedBefore = before ? normalizeSnapshot(before) : null;
  const normalizedAfter = normalizeSnapshot(after);

  const details: DiffDetail[] = [];

  for (const fieldPath of trackedFields) {
    const beforeRaw = before ? getPathValue(before, fieldPath) : null;
    const afterRaw = getPathValue(after, fieldPath);

    const beforeValue = toComparableString(beforeRaw, fieldPath);
    const afterValue = toComparableString(afterRaw, fieldPath);

    const valuesMatch =
      canonVersion >= 2 && fieldPath === 'proposalReason'
        ? canonicalizeProposalReasonForComparison(beforeValue) ===
          canonicalizeProposalReasonForComparison(afterValue)
        : beforeValue === afterValue;

    if (valuesMatch) {
      continue;
    }

    let changeType: ChangeDetailType;
    if (beforeValue === null && afterValue !== null) {
      changeType = 'added';
    } else if (beforeValue !== null && afterValue === null) {
      changeType = 'removed';
    } else {
      changeType = 'modified';
    }

    details.push({
      fieldPath,
      changeType,
      beforeValue,
      afterValue,
      beforeHash: hashComparable(beforeValue),
      afterHash: hashComparable(afterValue),
    });
  }

  const summary = {
    changedFields: details.map((detail) => detail.fieldPath),
    total: details.length,
  };

  return {
    changed: details.length > 0,
    changedFieldCount: details.length,
    details,
    normalizedBefore,
    normalizedAfter,
    diffSummaryJson: JSON.stringify(summary),
  };
}
