import { APP_CONSTANTS } from '../../../config/app.config';
import { BridgeLogLevel } from '../../discord-bridge/discord-bridge.types';
import { type DiscordBridgeService } from '../../discord-bridge/discord-bridge.service';
import { logAndBridge } from '../../../utils/bridge-log.utils';
import {
  describeNsmListScanHealth,
  recordNsmListScanResult,
  type NsmListScanHealth,
  type NsmListScanHealthStore,
  type NsmListScanOutcome,
} from './nsm-list-scan-health.util';

/**
 * Logger/bridge surface the reporter needs. Matches the shape the crawling
 * scheduler and archive-sync executors already pass around, so both paths (and
 * their specs) can reuse it unchanged.
 */
export interface NsmListScanReportDeps {
  cacheService: NsmListScanHealthStore;
  logger: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string, trace?: unknown): void;
  };
  discordBridge?: DiscordBridgeService;
}

/**
 * Reports the outcome of one completed NSM-shaped list scan and keeps the
 * run-length state that turns repetition into a signal.
 *
 * A zero-row scan is not "no new notices": the list source served nothing, which
 * is a failed observation. The first one warns (so a single hiccup is visible),
 * a run of `CRAWLING_NSM_LIST_SCAN_DEGRADED_THRESHOLD` of them escalates to an
 * ERROR-level alert and a degraded status on the status API, and recovery is
 * announced with how many scans were zero. Repeat alerts while degraded are
 * rate-limited to `CRAWLING_NSM_LIST_SCAN_ALERT_REPEAT_HOURS` so a long outage
 * does not alert on every cycle.
 *
 * @returns `true` when this scan returned zero rows — callers must then skip
 *          the reconciliation that assumes the list was actually read.
 */
export async function reportNsmListScanOutcome(params: {
  deps: NsmListScanReportDeps;
  itemsObserved: number;
  context: string;
  /** Short prefix for the log lines, e.g. `NSM pending scan`. */
  label: string;
  /** What the caller did *not* do because the list came back empty. */
  nextStepDescription: string;
  observedAt?: Date;
}): Promise<boolean> {
  const {
    deps,
    itemsObserved,
    context,
    label,
    nextStepDescription,
    observedAt = new Date(),
  } = params;

  let outcome: NsmListScanOutcome;
  let health: NsmListScanHealth;

  try {
    outcome = await recordNsmListScanResult(deps.cacheService, {
      itemsObserved,
      observedAt,
      degradedThreshold:
        APP_CONSTANTS.CRAWLING.NSM_LIST_SCAN_DEGRADED_THRESHOLD,
      alertRepeatHours: APP_CONSTANTS.CRAWLING.NSM_LIST_SCAN_ALERT_REPEAT_HOURS,
    });
    health = outcome.health;
  } catch (error) {
    // Run-length bookkeeping is an observability aid: a cache outage must never
    // fail the crawl, and the plain zero-row warning below still fires.
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn(
      `${label}: failed to record list-scan health (${message}); reporting this scan only`,
    );

    if (itemsObserved > 0) {
      return false;
    }

    logAndBridge({
      logger: deps.logger,
      method: 'warn',
      message: `${label} returned 0 notices: the list served no rows, so ${nextStepDescription} — check whether the source is refusing requests (blocked User-Agent, moved URL) or the adapter no longer matches the page`,
      context,
      discordBridge: deps.discordBridge,
      bridgeMessage: `${label} returned **0** notices — the list served no rows. ${nextStepDescription}.`,
    });
    return true;
  }

  const { lastSuccessfulScanAgoLabel } = describeNsmListScanHealth(
    health,
    observedAt,
  );
  const sourceLabel = `source=${health.source}`;

  if (itemsObserved > 0) {
    if (outcome.recoveredFromZeroRowScans > 0) {
      logAndBridge({
        logger: deps.logger,
        method: 'warn',
        message: `${label} recovered: ${itemsObserved} notice(s) (${sourceLabel}) after ${outcome.recoveredFromZeroRowScans} consecutive zero-row scan(s)`,
        context,
        discordBridge: deps.discordBridge,
        bridgeLevel: BridgeLogLevel.WARN,
        bridgeMessage: `${label} recovered: **${itemsObserved}** notice(s) (${sourceLabel}) after **${outcome.recoveredFromZeroRowScans}** consecutive zero-row scan(s)`,
        metadata: {
          itemsObserved,
          recoveredFromZeroRowScans: outcome.recoveredFromZeroRowScans,
        },
      });
    }

    return false;
  }

  logAndBridge({
    logger: deps.logger,
    method: 'warn',
    message: `${label} returned 0 notices (${sourceLabel}, zero-row scan ${health.consecutiveZeroRowScans}/${APP_CONSTANTS.CRAWLING.NSM_LIST_SCAN_DEGRADED_THRESHOLD}): the list served no rows, so ${nextStepDescription} — check whether the source is refusing requests (blocked User-Agent, moved URL) or the adapter no longer matches the page`,
    context,
    discordBridge: deps.discordBridge,
    bridgeMessage: `${label} returned **0** notices (${sourceLabel}, zero-row scan ${health.consecutiveZeroRowScans}/${APP_CONSTANTS.CRAWLING.NSM_LIST_SCAN_DEGRADED_THRESHOLD}) — the list served no rows. ${nextStepDescription}.`,
  });

  if (outcome.justDegraded || outcome.shouldRepeatAlert) {
    logAndBridge({
      logger: deps.logger,
      method: 'error',
      message: `${label}: collection is degraded — ${health.consecutiveZeroRowScans} consecutive completed scans returned 0 notices (${sourceLabel}, degraded since ${health.degradedSince}); ${lastSuccessfulScanAgoLabel ?? 'no successful scan recorded'}. The source is serving nothing, so notices are not being collected.`,
      context,
      discordBridge: deps.discordBridge,
      bridgeLevel: BridgeLogLevel.ERROR,
      bridgeMessage: `${label} degraded: **${health.consecutiveZeroRowScans}** consecutive zero-row scans (${sourceLabel}) — ${lastSuccessfulScanAgoLabel ?? 'no successful scan recorded'}. Collection has stopped.`,
      metadata: {
        consecutiveZeroRowScans: health.consecutiveZeroRowScans,
        degradedSince: health.degradedSince,
        lastSuccessfulScanAt: health.lastSuccessfulScanAt,
        lastAlertAt: health.lastAlertAt,
        source: health.source,
        justDegraded: outcome.justDegraded,
      },
    });
  }

  return true;
}
