/**
 * Runtime gate for NSM (`opinion.lawmaking.go.kr`) source-deletion detection.
 *
 * Every path that can mark an archived notice as `source_deleted`
 * (capture-error confirmation probes, the detail-page probe batch, and
 * NSM list reconciliation) consults this flag before doing any work, so
 * operators can turn the whole detection pipeline off via the
 * `CRAWLING_NSM_DELETION_DETECTION_ENABLED` environment variable without a
 * code change.
 *
 * The active collection source can also turn it off, and it wins: with
 * `CRAWLING_NSM_SOURCE=likms` the list comes from the National Assembly Bill
 * Information System while every confirmation path still asks
 * `opinion.lawmaking.go.kr` whether the bill exists, and that portal answers
 * `안건정보가 없습니다` for bills LIKMS still lists (measured 2026-10-14: bill
 * 2221889 deleted on NSM, alive in LIKMS). Marking such a row `source_deleted`
 * would be wrong, so detection stays off until the confirmation paths speak to
 * the portal that supplied the list.
 *
 * The setting is read from `process.env` on every call (not captured at module
 * load) so it takes effect without restarting the process, and so tests can
 * toggle it with plain env manipulation.
 */

import {
  NSM_SOURCE,
  isLikmsNsmSourceEnabled,
} from './crawler-activation.utils';

const NSM_DELETION_DETECTION_ENV_KEY =
  'CRAWLING_NSM_DELETION_DETECTION_ENABLED';

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

/** Why deletion detection is off. `null` means it is on. */
export type NsmDeletionDetectionDisabledReason = 'env' | 'likms-source';

/**
 * Returns why NSM source-deletion detection is off, or `null` when it is on.
 *
 * Precedence: the active source beats the env var. A LIKMS-backed list is
 * confirmed for deletion against a different portal, so detection is forced off
 * there and `CRAWLING_NSM_DELETION_DETECTION_ENABLED` is ignored.
 */
export function getNsmDeletionDetectionDisabledReason(): NsmDeletionDetectionDisabledReason | null {
  if (isLikmsNsmSourceEnabled()) {
    return 'likms-source';
  }

  const raw = process.env[NSM_DELETION_DETECTION_ENV_KEY];
  if (raw == null) {
    return null;
  }

  return DISABLED_VALUES.has(raw.trim().toLowerCase()) ? 'env' : null;
}

/**
 * Returns whether NSM source-deletion detection is currently enabled.
 * Missing, empty or unrecognized env values fall back to enabled, matching the
 * `parseBooleanWithDefault` semantics used in `app.config.ts`.
 */
export function isNsmDeletionDetectionEnabled(): boolean {
  return getNsmDeletionDetectionDisabledReason() === null;
}

/**
 * Explains an inactive detection pipeline in one clause for skip logs, naming
 * the reason so an operator does not hunt for an env var they never set.
 */
export function describeNsmDeletionDetectionDisabled(): string {
  if (getNsmDeletionDetectionDisabledReason() === 'likms-source') {
    return (
      `deletion detection is off because the active source is ${NSM_SOURCE.LIKMS}: ` +
      'deletion is still confirmed against opinion.lawmaking.go.kr, which reports LIKMS-listed bills as missing'
    );
  }

  return `deletion detection is off via ${NSM_DELETION_DETECTION_ENV_KEY}`;
}
