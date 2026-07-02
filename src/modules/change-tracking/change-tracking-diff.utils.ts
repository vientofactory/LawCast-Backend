import { createHash } from 'crypto';
import { type ChangeDetailType } from './notice-change-detail.entity';

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

// Track only user-meaningful notice metadata and proposal text.
export const DEFAULT_TRACKED_FIELDS = [
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
] as const;

function normalizeString(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
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

function toComparableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return normalizeString(value);
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
): DiffComputationResult {
  const normalizedBefore = before ? normalizeSnapshot(before) : null;
  const normalizedAfter = normalizeSnapshot(after);

  const details: DiffDetail[] = [];

  for (const fieldPath of trackedFields) {
    const beforeRaw = normalizedBefore
      ? getPathValue(normalizedBefore, fieldPath)
      : null;
    const afterRaw = getPathValue(normalizedAfter, fieldPath);

    const beforeValue = toComparableString(beforeRaw);
    const afterValue = toComparableString(afterRaw);

    if (beforeValue === afterValue) {
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
