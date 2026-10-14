import {
  getActiveNsmSource,
  type NsmSource,
} from '../../../utils/crawler-activation.utils';

/**
 * Cache key holding the NSM-shaped list scan health record.
 *
 * A list scan that returns zero rows used to be reported exactly like a scan
 * with nothing new, so a source that had started refusing every request (blocked
 * User-Agent, moved URL, adapter mismatch) kept the pipeline reporting "no new
 * notices" indefinitely — the incident that motivated this tracker went
 * unnoticed for five weeks. The tracker makes the difference explicit: zero rows
 * is a *failed observation*, and a run of them is a degraded collector that the
 * status API and Discord both report.
 */
export const NSM_LIST_SCAN_HEALTH_CACHE_KEY = 'crawling:nsmListScanHealth';

/**
 * Two scans recorded this close together are treated as the same cycle: the
 * cron pending pass and the archive-sync pending phase both scan the list, and
 * counting both would double the streak for one stalled cycle.
 */
export const NSM_LIST_SCAN_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/** Structural subset of `CacheService` this tracker needs. */
export interface NsmListScanHealthStore {
  getObject<T>(key: string): Promise<T | null>;
  setObject<T>(key: string, value: T, ttl?: number): Promise<boolean>;
}

export interface NsmListScanHealth {
  /** Source that served (or refused) the scan, so the alert can name the portal. */
  source: NsmSource;
  /** Last completed scan regardless of row count. */
  lastScanAt: string | null;
  lastScanItemCount: number;
  /** Last scan that actually returned rows. */
  lastSuccessfulScanAt: string | null;
  lastSuccessfulScanItemCount: number;
  /** Completed scans in a row that returned zero rows (0 when healthy). */
  consecutiveZeroRowScans: number;
  /** True once the streak reached the configured threshold. */
  degraded: boolean;
  degradedSince: string | null;
  /** Last ERROR-level alert, used to rate-limit repeats while degraded. */
  lastAlertAt: string | null;
}

export interface NsmListScanOutcome {
  health: NsmListScanHealth;
  /** This scan returned no rows at all. */
  isZeroRowScan: boolean;
  /** The degraded state was just entered (first alert). */
  justDegraded: boolean;
  /** Already degraded and the repeat-alert interval has elapsed. */
  shouldRepeatAlert: boolean;
  /** Zero-row scans that preceded a recovery (0 when this scan was fine). */
  recoveredFromZeroRowScans: number;
}

export interface RecordNsmListScanParams {
  itemsObserved: number;
  observedAt: Date;
  degradedThreshold: number;
  alertRepeatHours: number;
  source?: NsmSource;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function buildInitialHealth(
  source: NsmSource,
  observedAt: Date,
): NsmListScanHealth {
  return {
    source,
    lastScanAt: toIso(observedAt),
    lastScanItemCount: 0,
    lastSuccessfulScanAt: null,
    lastSuccessfulScanItemCount: 0,
    consecutiveZeroRowScans: 0,
    degraded: false,
    degradedSince: null,
    lastAlertAt: null,
  };
}

/**
 * Reads the persisted health record.
 *
 * Returns `null` when nothing has been recorded yet (fresh install, flushed
 * cache); callers must treat that as "unknown" rather than healthy.
 */
export async function readNsmListScanHealth(
  store: Pick<NsmListScanHealthStore, 'getObject'>,
): Promise<NsmListScanHealth | null> {
  const stored = await store.getObject<NsmListScanHealth>(
    NSM_LIST_SCAN_HEALTH_CACHE_KEY,
  );

  if (!stored || typeof stored !== 'object') {
    return null;
  }

  return stored;
}

/**
 * Folds one completed list scan into the health record and reports what the
 * caller should say about it.
 *
 * A zero-row scan increments the streak; any scan with rows resets it. The
 * degraded state latches on the threshold crossing so the caller can alert once
 * on entry (and again on a slower repeat interval) instead of repeating the
 * same message on every cycle, while the API keeps reporting the degraded state
 * for as long as it lasts.
 */
export async function recordNsmListScanResult(
  store: NsmListScanHealthStore,
  params: RecordNsmListScanParams,
): Promise<NsmListScanOutcome> {
  const {
    itemsObserved,
    observedAt,
    degradedThreshold,
    alertRepeatHours,
    source = getActiveNsmSource(),
  } = params;

  const previous =
    (await readNsmListScanHealth(store)) ??
    buildInitialHealth(source, observedAt);

  const observedAtMs = observedAt.getTime();
  const previousScanAtMs = parseIso(previous.lastScanAt);
  const isSameCycle =
    previousScanAtMs !== null &&
    observedAtMs - previousScanAtMs >= 0 &&
    observedAtMs - previousScanAtMs < NSM_LIST_SCAN_DEDUPE_WINDOW_MS;

  const threshold = Math.max(1, degradedThreshold);
  const isZeroRowScan = itemsObserved <= 0;

  // Same-cycle duplicate: keep the streak from growing twice per stalled cycle.
  const streak = isZeroRowScan
    ? isSameCycle
      ? Math.max(1, previous.consecutiveZeroRowScans)
      : previous.consecutiveZeroRowScans + 1
    : 0;

  const wasDegraded = previous.degraded === true;
  const degraded = isZeroRowScan && streak >= threshold;
  const justDegraded = degraded && !wasDegraded;

  const previousAlertAtMs = parseIso(previous.lastAlertAt);
  const repeatIntervalMs = Math.max(0, alertRepeatHours) * 60 * 60 * 1000;
  const shouldRepeatAlert =
    degraded &&
    !justDegraded &&
    (previousAlertAtMs === null ||
      observedAtMs - previousAlertAtMs >= repeatIntervalMs);

  const health: NsmListScanHealth = {
    source,
    lastScanAt: toIso(observedAt),
    lastScanItemCount: itemsObserved,
    lastSuccessfulScanAt: isZeroRowScan
      ? previous.lastSuccessfulScanAt
      : toIso(observedAt),
    lastSuccessfulScanItemCount: isZeroRowScan
      ? previous.lastSuccessfulScanItemCount
      : itemsObserved,
    consecutiveZeroRowScans: streak,
    degraded,
    degradedSince: degraded
      ? wasDegraded
        ? previous.degradedSince
        : toIso(observedAt)
      : null,
    lastAlertAt:
      justDegraded || shouldRepeatAlert
        ? toIso(observedAt)
        : previous.lastAlertAt,
  };

  await store.setObject(NSM_LIST_SCAN_HEALTH_CACHE_KEY, health);

  return {
    health,
    isZeroRowScan,
    justDegraded,
    shouldRepeatAlert,
    recoveredFromZeroRowScans: isZeroRowScan
      ? 0
      : previous.consecutiveZeroRowScans,
  };
}

/**
 * Adds the derived fields the status API reports: how long the collector has
 * gone without a readable list, and a ready-to-render description for it.
 */
export function describeNsmListScanHealth(
  health: NsmListScanHealth | null,
  now: Date = new Date(),
): {
  staleHours: number | null;
  lastSuccessfulScanAgoLabel: string | null;
} {
  if (!health) {
    return { staleHours: null, lastSuccessfulScanAgoLabel: null };
  }

  const lastSuccessfulMs = parseIso(health.lastSuccessfulScanAt);
  if (lastSuccessfulMs === null) {
    return {
      staleHours: null,
      lastSuccessfulScanAgoLabel: 'no successful list scan recorded yet',
    };
  }

  const staleHours = Math.max(
    0,
    Math.round(((now.getTime() - lastSuccessfulMs) / (60 * 60 * 1000)) * 10) /
      10,
  );

  return {
    staleHours,
    lastSuccessfulScanAgoLabel: `${staleHours} hour(s) since the last list scan that returned rows`,
  };
}
