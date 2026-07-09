export interface DbErrorMeta {
  code: string;
  constraint: string;
  message: string;
  detail: string;
  errno: number | null;
}

const DEFAULT_RETRYABLE_NETWORK_OR_SYSTEM_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'EAGAIN',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
]);

export function isRetryableNetworkOrSystemError(
  error: unknown,
  retryableCodes: ReadonlySet<string> = DEFAULT_RETRYABLE_NETWORK_OR_SYSTEM_CODES,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errno = error as NodeJS.ErrnoException;
  const code = errno.code?.toUpperCase();
  if (code && retryableCodes.has(code)) {
    return true;
  }

  const message = (errno.message ?? '').toUpperCase();
  for (const candidate of retryableCodes) {
    if (message.includes(candidate)) {
      return true;
    }
  }

  return false;
}

export function getDbErrorCandidates(error: unknown): unknown[] {
  const candidates = [error];
  const driverError = (error as { driverError?: unknown } | undefined)
    ?.driverError;

  if (driverError) {
    candidates.push(driverError);
  }

  return candidates;
}

export function extractDbErrorMeta(value: unknown): DbErrorMeta {
  const obj = (value as Record<string, unknown> | undefined) ?? {};
  const code = String(obj.code ?? '').toLowerCase();
  const constraint = String(obj.constraint ?? '').toLowerCase();
  const message = String(obj.message ?? '').toLowerCase();
  const detail = String(obj.detail ?? '').toLowerCase();
  const errnoRaw = obj.errno;
  const errno =
    typeof errnoRaw === 'number'
      ? errnoRaw
      : typeof errnoRaw === 'string'
        ? Number.parseInt(errnoRaw, 10)
        : null;

  return {
    code,
    constraint,
    message,
    detail,
    errno: Number.isNaN(errno ?? Number.NaN) ? null : errno,
  };
}

export function isKnownUniqueConstraintCode(meta: {
  code: string;
  errno: number | null;
}): boolean {
  return (
    meta.code === '23505' ||
    meta.code === 'sqlite_constraint' ||
    meta.code === 'sqlite_constraint_unique' ||
    meta.code === 'er_dup_entry' ||
    meta.errno === 1062
  );
}

export function isUniqueConstraintConflictError(
  error: unknown,
  targetConstraints: string[],
): boolean {
  for (const candidate of getDbErrorCandidates(error)) {
    const meta = extractDbErrorMeta(candidate);
    const joinedText = `${meta.constraint} ${meta.detail} ${meta.message}`;
    const isTargetConstraint = targetConstraints.some((constraint) =>
      joinedText.includes(constraint),
    );

    if (!isTargetConstraint) {
      continue;
    }

    const hasUniqueViolationText =
      meta.message.includes('unique constraint') ||
      meta.detail.includes('unique constraint') ||
      meta.detail.includes('duplicate key');

    if (isKnownUniqueConstraintCode(meta) || hasUniqueViolationText) {
      return true;
    }
  }

  return false;
}
