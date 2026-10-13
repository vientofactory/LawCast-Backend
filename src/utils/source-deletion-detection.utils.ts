/**
 * Runtime gate for NSM (`opinion.lawmaking.go.kr`) source-deletion detection.
 *
 * Every path that can mark an archived notice as `source_deleted`
 * (capture-error confirmation probes, the detail-page probe batch, and
 * NSM list reconciliation) consults this flag before doing any work, so
 * operators can turn the whole detection pipeline off via the
 * `CRAWLING_NSM_DELETION_DETECTION_ENABLED` environment variable without a
 * code change. Default: enabled (current behavior preserved).
 *
 * The flag is read from `process.env` on every call (not captured at module
 * load) so the setting takes effect without restarting the process, and so
 * tests can toggle it with plain env manipulation.
 */

const NSM_DELETION_DETECTION_ENV_KEY =
  'CRAWLING_NSM_DELETION_DETECTION_ENABLED';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Returns whether NSM source-deletion detection is currently enabled.
 * Missing, empty or unrecognized values fall back to enabled, matching the
 * `parseBooleanWithDefault` semantics used in `app.config.ts`.
 */
export function isNsmDeletionDetectionEnabled(): boolean {
  const raw = process.env[NSM_DELETION_DETECTION_ENV_KEY];
  if (raw == null) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) {
    return true;
  }
  if (DISABLED_VALUES.has(normalized)) {
    return false;
  }

  return true;
}
