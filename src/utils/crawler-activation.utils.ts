/**
 * Runtime gates for the two independent crawler sources LawCast collects from.
 *
 * - PAL (`pal.assembly.go.kr`): formal legislative notices (`입법예고`).
 * - NSM (`opinion.lawmaking.go.kr`, NsmLmSts): bills proposed at the National
 *   Assembly public-participation portal before they enter the formal process.
 *
 * Each source can be disabled independently through an environment variable:
 *   - CRAWLING_PAL_ENABLED
 *   - CRAWLING_NSM_ENABLED
 *
 * Every collection entry point and every snapshot/change-tracking path (archive
 * upsert, diffchain events, source-deletion reconciliation, snapshot backfill)
 * consults the matching flag before doing work, so a disabled crawler never
 * collects data and never reaches the archive (snapshot) or change-tracking
 * (diffchain) code paths. Disabling both is a configuration error:
 * `assertAtLeastOneCrawlerEnabled()` throws so the bootstrap can fail fast
 * instead of running a server that can never collect anything.
 *
 * The flags are read from `process.env` on every call (not captured at module
 * load) so operators can toggle them without a restart, and so tests can toggle
 * them with plain env manipulation. Missing, empty or unrecognized values fall
 * back to enabled, matching `parseBooleanWithDefault` semantics in
 * `app.config.ts` and preserving the pre-existing default behavior.
 */

/** Identifier for each collection source, used by logging and guard helpers. */
export const CRAWLER_SOURCE = {
  PAL: 'pal',
  NSM: 'nsm',
} as const;

export type CrawlerSource =
  (typeof CRAWLER_SOURCE)[keyof typeof CRAWLER_SOURCE];

const PAL_ENABLED_ENV_KEY = 'CRAWLING_PAL_ENABLED';
const NSM_ENABLED_ENV_KEY = 'CRAWLING_NSM_ENABLED';
const NSM_SOURCE_ENV_KEY = 'CRAWLING_NSM_SOURCE';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

/** Snapshot of which crawler sources are currently enabled. */
export interface CrawlerActivationState {
  pal: boolean;
  nsm: boolean;
  anyEnabled: boolean;
}

/**
 * Parses a crawler enable flag. Missing/unrecognized values default to enabled
 * so the flag is opt-out; only an explicit false-ish value disables a crawler.
 */
function parseEnabled(raw: string | undefined): boolean {
  if (raw == null) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  if (DISABLED_VALUES.has(normalized)) {
    return false;
  }
  if (ENABLED_VALUES.has(normalized)) {
    return true;
  }

  return true;
}

/** Returns whether the PAL (`pal.assembly.go.kr`) crawler is enabled. */
export function isPalCrawlerEnabled(): boolean {
  return parseEnabled(process.env[PAL_ENABLED_ENV_KEY]);
}

/** Returns whether the NSM (`opinion.lawmaking.go.kr`) crawler is enabled. */
export function isNsmCrawlerEnabled(): boolean {
  return parseEnabled(process.env[NSM_ENABLED_ENV_KEY]);
}

/**
 * Selectable backend for the NSM-shaped bill list/detail crawl.
 *
 * - `nsm`: `국민참여입법센터` `입법진행현황` (`opinion.lawmaking.go.kr`, `NsmLmSts`).
 * - `likms`: `국회 의안정보시스템` `계류의안` (`likms.assembly.go.kr`), reached through
 *   pal-crawl's `LikmsNsmAdapter` which implements the same list/detail ports.
 */
export const NSM_SOURCE = {
  NSM: 'nsm',
  LIKMS: 'likms',
} as const;

export type NsmSource = (typeof NSM_SOURCE)[keyof typeof NSM_SOURCE];

/**
 * Returns whether NSM-shaped list/detail crawling should be served by the
 * National Assembly Bill Information System (the `계류의안` list) instead of the
 * public-participation portal.
 *
 * Only the exact value `likms` (case-insensitive, trimmed) switches the source;
 * an unset or unrecognized value keeps the existing NSM behavior, so the flag is
 * strictly opt-in. Read from `process.env` on every call (like the enable flags)
 * so operators can flip it without a restart and tests can toggle it per case.
 */
export function isLikmsNsmSourceEnabled(): boolean {
  const raw = process.env[NSM_SOURCE_ENV_KEY];
  if (raw == null) {
    return false;
  }

  return raw.trim().toLowerCase() === NSM_SOURCE.LIKMS;
}

/**
 * Returns the NSM-shaped source currently serving list/detail crawls, so log
 * lines can name the portal a zero-row scan or an unreadable probe came from.
 */
export function getActiveNsmSource(): NsmSource {
  return isLikmsNsmSourceEnabled() ? NSM_SOURCE.LIKMS : NSM_SOURCE.NSM;
}

/**
 * Returns whether the separate pending-list scan is redundant for the active
 * source, so callers can skip a second traversal of the same list.
 *
 * The LIKMS adapter builds its pending list (`접수`) from the very same
 * `계류의안` list the all-bills scan already walked and filters rows
 * client-side (`progressStatus === '접수'`), which is exactly the vocabulary
 * `CrawlingCoreService.isPendingProgressStatus` recognises. Walking it a second
 * time therefore costs a full extra traversal of a ~160-page list while adding
 * no bill the all-bills scan did not already classify as pending-like.
 *
 * The NSM portal answers a separate server-filtered query
 * (`rslRsltNmL=900101`), whose result is not guaranteed to be a subset of its
 * all-bills list, so the NSM pending stream is still walked.
 */
export function isNsmPendingStreamRedundant(): boolean {
  return isLikmsNsmSourceEnabled();
}

/**
 * Returns whether the active NSM-shaped source can serve snapshots and
 * screenshots for the bills it lists.
 *
 * The two flags answer different questions. `CRAWLING_NSM_ENABLED` gates the
 * `국민참여입법센터` portal itself; with `CRAWLING_NSM_SOURCE=likms` the snapshot
 * and the screenshot are captured from the likms detail page with this
 * application's own browser session, so they are available even when the NSM
 * portal is switched off. Callers that decide whether to open a browser for a
 * list-source bill must use this instead of the NSM enable flag, which would
 * silently skip every likms screenshot.
 */
export function isSnapshotSourceCaptureEnabled(): boolean {
  return isLikmsNsmSourceEnabled() || isNsmCrawlerEnabled();
}

/** Returns whether the given crawler source is currently enabled. */
export function isCrawlerEnabled(source: CrawlerSource): boolean {
  return source === CRAWLER_SOURCE.NSM
    ? isNsmCrawlerEnabled()
    : isPalCrawlerEnabled();
}

/** Returns a snapshot of the activation state of both crawler sources. */
export function getCrawlerActivationState(): CrawlerActivationState {
  const pal = isPalCrawlerEnabled();
  const nsm = isNsmCrawlerEnabled();

  return { pal, nsm, anyEnabled: pal || nsm };
}

/** Thrown when both crawler sources are disabled during bootstrap. */
export class CrawlerActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlerActivationError';
  }
}

/**
 * Asserts that at least one crawler source is enabled.
 *
 * Called during application bootstrap: a server with both crawlers disabled
 * can never collect or refresh any notice, so it must not start. Throws
 * `CrawlerActivationError` when both flags are explicitly disabled; the
 * bootstrap catch handler turns that into `process.exit(1)`.
 *
 * @returns The activation state when at least one crawler is enabled.
 * @throws CrawlerActivationError when both crawlers are disabled.
 */
export function assertAtLeastOneCrawlerEnabled(): CrawlerActivationState {
  const state = getCrawlerActivationState();

  if (!state.anyEnabled) {
    throw new CrawlerActivationError(
      'At least one crawler must be enabled: both CRAWLING_PAL_ENABLED and CRAWLING_NSM_ENABLED are disabled. ' +
        'Set one of them to true (or unset it to use the enabled default).',
    );
  }

  return state;
}
