import { type AISummaryStatus } from '../../../types/cache.types';

export const AI_SUMMARY_STATUS = {
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  NOT_SUPPORTED: 'not_supported',
  NOT_REQUESTED: 'not_requested',
} as const;

/**
 * `not_requested` means the row has not entered the summary pipeline yet.
 * This is the only state that should be drained by summary backfill.
 */
export function isSummaryNotRequested(
  status?: AISummaryStatus | null,
): status is 'not_requested' {
  return (
    (status ?? AI_SUMMARY_STATUS.NOT_REQUESTED) ===
    AI_SUMMARY_STATUS.NOT_REQUESTED
  );
}

/**
 * `unavailable` means summary generation was attempted but failed.
 * This is the only state that should be retried by unavailable-summary retry.
 */
export function isSummaryUnavailable(
  status?: AISummaryStatus | null,
): status is 'unavailable' {
  return status === AI_SUMMARY_STATUS.UNAVAILABLE;
}

/**
 * When a summary was attempted but the generator reported `not_requested`
 * despite AI being enabled, treat it as a failed attempt rather than an
 * untouched row so the retry/backfill pipeline stays consistent.
 */
export function normalizeAttemptedSummaryStatus(
  status: AISummaryStatus,
  aiSummaryEnabled: boolean,
): AISummaryStatus {
  if (aiSummaryEnabled && status === AI_SUMMARY_STATUS.NOT_REQUESTED) {
    return AI_SUMMARY_STATUS.UNAVAILABLE;
  }

  return status;
}
